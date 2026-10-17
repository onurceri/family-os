import { createHash } from 'node:crypto';
import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import { type ExtensionDefinition, type LlmPort, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { defaultHourCycle, defaultWeekStart, epochOf, formatLocaleForLanguage } from '@famos/time';
import inbox from '../src/server/index.ts';
import { promptHash } from '../src/server/understand/prompt.ts';
import {
	CASES,
	type Case,
	type Check,
	DEFAULT_FAMILY,
	type Draft,
	type Listed,
	type Members,
} from './cases.ts';

/**
 * The household a case runs in, shared by the eval (a real model) and the replay of its
 * recordings in the tests (the fake model), so both read a message on the same kernel.
 */

/** The records area only for cases that bring duties, so the other cases keep their catalog. */
export function extensionsOf(c: Case): ExtensionDefinition[] {
	return c.obligations ? [calendar, lists, records, inbox] : [calendar, lists, inbox];
}

/**
 * A fingerprint of every prompt the cases are read with (one per set of installed extensions).
 * The baseline keeps it: when it changes, the model is asked something else and the eval has to
 * run again.
 */
export async function casesPromptHash(cases: readonly Case[] = CASES): Promise<string> {
	const sets = new Map<string, ExtensionDefinition[]>();
	for (const c of cases) {
		const extensions = extensionsOf(c);
		sets.set(extensions.map((e) => e.id).join(','), extensions);
	}
	const hashes: string[] = [];
	for (const [key, extensions] of [...sets].sort(([a], [b]) => a.localeCompare(b))) {
		const k = await createTestKernel({ extensions });
		try {
			hashes.push(`${key}:${promptHash(k.ctx.actions.aiKinds())}`);
		} finally {
			await k.close();
		}
	}
	return createHash('sha256').update(hashes.join('\n')).digest('hex').slice(0, 8);
}

export interface CaseOutcome {
	/** What became of the item (`extracted` when it was read). */
	status: string;
	errorCode: string | null;
	skipped: number;
	drafts: Draft[];
	members: Members;
	results: { check: Check; ok: boolean }[];
}

/** What failed in a case, as the baseline lists it: the reading itself, then each check. */
export function failedChecks(outcome: CaseOutcome): string[] {
	return [
		...(outcome.status === 'extracted' ? [] : [`the item was read (${outcome.status})`]),
		...outcome.results.filter((r) => !r.ok).map((r) => r.check.label),
	];
}

/**
 * Seeds the case's household on a fresh kernel (with `llm`, or the fake model the caller fills
 * through `prepare`), shares its message as the first member, reads it and judges the drafts.
 */
export async function runCaseOn(
	c: Case,
	options: { llm?: LlmPort; prepare?: (k: TestKernel) => void } = {},
): Promise<CaseOutcome> {
	const k = await createTestKernel({
		extensions: extensionsOf(c),
		...(options.llm && { llm: options.llm }),
	});
	try {
		const format = c.formatLocale ?? formatLocaleForLanguage(c.locale ?? 'en');
		await k.runner.invoke(
			'core.updateFamilySettings',
			{
				timeZone: c.timeZone ?? 'UTC',
				locale: c.locale ?? 'en',
				// As setup would: the region format and what follows from it.
				formatLocale: format,
				weekStart: defaultWeekStart(format),
				hourCycle: defaultHourCycle(format),
			},
			systemActor('eval'),
		);
		k.clock.set(epochOf('2026-10-06', '10:00', c.timeZone ?? 'UTC'));
		for (const [n, duty] of (c.obligations ?? []).entries()) {
			await k.runner.invoke(
				'records.addObligation',
				{
					...duty,
					recordId: `${duty.recordKind}_00000000-0000-7000-8000-${String(n + 1).padStart(12, '0')}`,
				},
				systemActor('eval'),
			);
		}
		const listed: Listed = {};
		const shoppingLists = new Map<string, string>();
		for (const { list, title } of c.shopping ?? []) {
			let listId: string | undefined;
			if (list) {
				listId = shoppingLists.get(list);
				if (!listId) {
					const made = await k.runner.invoke<{ id: string }>(
						'lists.createShoppingList',
						{ name: list },
						systemActor('eval'),
					);
					if (made.status !== 'applied') throw new Error('expected the list to be made');
					listId = made.output.id;
					shoppingLists.set(list, listId);
				}
			}
			const added = await k.runner.invoke<{ items: { id: string }[] }>(
				'lists.addShoppingItems',
				{ ...(listId && { listId }), items: [{ title }] },
				systemActor('eval'),
			);
			if (added.status !== 'applied') throw new Error('expected the item to be added');
			listed[title] = added.output.items[0]?.id as string;
		}
		for (const event of c.events ?? []) {
			const added = await k.runner.invoke('calendar.createEvent', event, systemActor('eval'));
			if (added.status !== 'applied') throw new Error('expected the event to be added');
		}
		for (const title of c.tasks ?? []) {
			const added = await k.runner.invoke<{ id: string }>(
				'lists.addTask',
				{ title },
				systemActor('eval'),
			);
			if (added.status !== 'applied') throw new Error('expected the task to be added');
			listed[title] = added.output.id;
		}
		const members: Members = {};
		let sharer: Awaited<ReturnType<typeof k.member>> | undefined;
		for (const person of c.family ?? DEFAULT_FAMILY) {
			const created = await k.member(person.roleId, person.name);
			if (person.about) {
				await k.runner.invoke(
					'core.updateMember',
					{ memberId: created.member.id, about: person.about },
					systemActor('eval'),
				);
			}
			members[person.name] = created.member.id;
			sharer ??= created;
		}
		options.prepare?.(k);
		const item = await k.route('inbox.createItem').call({
			body: { channel: 'share', text: c.text },
			files: [],
			actor: sharer?.actor,
		});
		await k.worker.drain();
		const [state] = await k
			.route('inbox.listItems')
			.call({ query: { limit: 1 }, actor: sharer?.actor });
		const drafts: Draft[] = (
			await k
				.route('core.listDrafts')
				.call({ query: { sourceId: item.id, limit: 50 }, actor: sharer?.actor })
		).reverse();
		return {
			status: state.status,
			errorCode: state.errorCode ?? null,
			skipped: state.skipped ?? 0,
			drafts,
			members,
			results: c.checks.map((check) => ({
				check,
				ok: check.pass(drafts, members, state, c.text, listed),
			})),
		};
	} finally {
		await k.close();
	}
}
