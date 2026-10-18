import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ExtensionDefinition, type LlmPort, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { defaultHourCycle, defaultWeekStart, epochOf, formatLocaleForLanguage } from '@famos/time';
import { promptHash } from '../src/server/understand/prompt.ts';
import {
	type Case,
	type Check,
	DEFAULT_FAMILY,
	type Draft,
	type Failure,
	type FixtureName,
	type Listed,
	type Members,
} from './cases.ts';

/**
 * The household a case runs in, shared by the eval (a real model) and the replay of its
 * recordings in the tests (the fake model), so both read a message on the same kernel.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Longer than any backoff of the queue between two tries of a job. */
const RETRY_WAIT_MS = 60 * 60_000;

let bundled: Promise<ExtensionDefinition[]> | undefined;

/**
 * Every extension the app ships, always installed or offered, as a family that installed them
 * all has them: the model is then asked with every kind and example a real family can be shown.
 * They are loaded from their workspace folders by the list the app ships (`extensions.json`)
 * rather than imported by name, because several of them already depend on the inbox for their
 * own tests, and a package cannot depend back on them.
 */
export function bundledExtensions(): Promise<ExtensionDefinition[]> {
	bundled ??= (async () => {
		const shipped = JSON.parse(readFileSync(join(REPO, 'extensions.json'), 'utf8')) as {
			always: string[];
			offered: string[];
		};
		const ids = [...new Set([...shipped.always, ...shipped.offered])].sort();
		return Promise.all(
			ids.map(async (id) => {
				const dir = join(REPO, 'extensions', id);
				const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
					exports: { './server': string };
				};
				const module = (await import(pathToFileURL(join(dir, pkg.exports['./server'])).href)) as {
					default: ExtensionDefinition;
				};
				return module.default;
			}),
		);
	})();
	return bundled;
}

/**
 * A fingerprint of the prompt every case is read with. The baseline keeps it: when it changes,
 * the model is asked something else and the eval has to run again.
 */
export async function casesPromptHash(): Promise<string> {
	const k = await createTestKernel({ extensions: await bundledExtensions() });
	try {
		return promptHash(k.ctx.actions.aiKinds());
	} finally {
		await k.close();
	}
}

/** What a household already holds when a case starts: seeded like a case's own `shopping`, `tasks` and `seed`. */
interface Fixture {
	shopping: NonNullable<Case['shopping']>;
	seed: NonNullable<Case['seed']>;
}

/**
 * The Novak household, as it stood in the simulation the messages come from: it needs a family
 * with Tom, Mara, Ivy and Leo. It holds what makes a family's messages hard to place:
 * - two lessons with one name for two people (the moved event is a lesson one week of which sits
 *   on another day);
 * - two class trips whose names differ by a code, and two cars whose plates differ by a code;
 * - a second shopping list next to the default one.
 */
const NOVAK: Fixture = {
	shopping: [
		{ title: 'Milk' },
		{ title: 'Bread' },
		{ list: 'Hardware store', title: 'Picture wire' },
		{ list: 'Hardware store', title: 'Batteries' },
	],
	seed: [
		{ action: 'pets.addPet', input: { name: 'Biscuit', species: 'dog' } },
		{
			action: 'vehicles.addVehicle',
			input: { name: 'Octavia', plate: 'LJ AB-123', fuel: 'diesel' },
		},
		{ action: 'vehicles.addVehicle', input: { name: 'Golf', plate: 'LJ CD-456', fuel: 'petrol' } },
		{
			action: 'calendar.createEvent',
			as: 'Football training',
			input: {
				title: 'Football training',
				date: '2026-10-07',
				startTime: '17:30',
				endTime: '19:00',
				memberIds: ['@Ivy'],
				recurrence: { freq: 'weekly', byDay: ['WE'] },
			},
		},
		{
			action: 'calendar.createEvent',
			as: 'Swim lesson Ivy',
			input: {
				title: 'Swim lesson Ivy',
				date: '2026-10-10',
				startTime: '09:00',
				endTime: '10:00',
				location: 'City pool',
				memberIds: ['@Ivy'],
				recurrence: { freq: 'weekly', byDay: ['SA'] },
			},
		},
		{
			action: 'calendar.createEvent',
			as: 'Swim lesson Tom',
			input: {
				title: 'Swim lesson Tom',
				date: '2026-10-10',
				startTime: '09:30',
				endTime: '10:30',
				location: 'City pool',
				memberIds: ['@Tom'],
				recurrence: { freq: 'weekly', byDay: ['SA'] },
			},
		},
		{
			action: 'calendar.createEvent',
			as: 'Piano series',
			input: {
				title: 'Piano lesson',
				date: '2026-10-01',
				startTime: '16:00',
				endTime: '16:45',
				memberIds: ['@Ivy'],
				recurrence: { freq: 'weekly', byDay: ['TH'] },
			},
		},
		// The lesson of 15 October sits on Friday this week: a one-off event of its own.
		{
			action: 'calendar.changeEvent',
			as: 'Piano lesson moved',
			input: {
				id: '$6',
				occurrence: '2026-10-15',
				date: '2026-10-16',
				startTime: '17:00',
				endTime: '17:45',
			},
		},
		{
			action: 'calendar.createEvent',
			as: 'Class 1B trip',
			input: {
				title: 'Class 1B trip',
				date: '2026-10-30',
				startTime: '08:10',
				memberIds: ['@Leo'],
			},
		},
		{
			action: 'calendar.createEvent',
			as: 'Class 4B trip',
			input: {
				title: 'Class 4B trip',
				date: '2026-11-06',
				startTime: '09:00',
				memberIds: ['@Ivy'],
			},
		},
	],
};

const FIXTURES: Record<FixtureName, Fixture> = { novak: NOVAK };

export interface CaseOutcome {
	/** What became of the item (`extracted` when it was read). */
	status: string;
	errorCode: string | null;
	skipped: number;
	drafts: Draft[];
	members: Members;
	results: { check: Check; ok: boolean; failure: Failure | null }[];
}

/** What failed in a case, as the baseline lists it: the reading itself, then each check. */
export function failedChecks(outcome: CaseOutcome): string[] {
	return [
		...(outcome.status === 'extracted' ? [] : [`the item was read (${outcome.status})`]),
		...outcome.results.filter((r) => !r.ok).map((r) => r.check.label),
	];
}

/** The failed checks that are harmful (a wrong value shown as certain, or a wrong thing acted on). */
export function harmfulChecks(outcome: CaseOutcome): string[] {
	return outcome.results.filter((r) => r.failure === 'harmful').map((r) => r.check.label);
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
		extensions: await bundledExtensions(),
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
		const fixture = c.fixture ? FIXTURES[c.fixture] : undefined;
		const shoppingLists = new Map<string, string>();
		for (const { list, title } of [...(fixture?.shopping ?? []), ...(c.shopping ?? [])]) {
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
					listed[`list:${list}`] = listId;
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
		const filled = (value: unknown, made: string[]): unknown => {
			if (typeof value === 'string') {
				if (value.startsWith('@')) return members[value.slice(1)] ?? value;
				if (/^\$\d+$/u.test(value)) return made[Number(value.slice(1))] ?? value;
				return value;
			}
			if (Array.isArray(value)) return value.map((one) => filled(one, made));
			if (value && typeof value === 'object')
				return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, filled(v, made)]));
			return value;
		};
		// `$n` is the id step n of the same list made, so a fixture and a case do not shift each other.
		const seeded = async (steps: NonNullable<Case['seed']>) => {
			const made: string[] = [];
			for (const step of steps) {
				const done = await k.runner.invoke<{ id?: string }>(
					step.action,
					filled(step.input, made),
					systemActor('eval'),
				);
				if (done.status !== 'applied') throw new Error(`expected ${step.action} to be applied`);
				made.push(done.output.id ?? '');
				if (step.as) listed[step.as] = done.output.id ?? '';
			}
		};
		if (fixture) await seeded(fixture.seed);
		await seeded(c.seed ?? []);
		options.prepare?.(k);
		const item = await k.route('inbox.createItem').call({
			body: { channel: 'share', text: c.text },
			files: [],
			actor: sharer?.actor,
		});
		const read = async () =>
			(await k.route('inbox.listItems').call({ query: { limit: 1 }, actor: sharer?.actor }))[0];
		await k.worker.drain();
		let state = await read();
		// A reading that failed in a way worth another try waits for it, as it would at home: the
		// queue asks again after its backoff, so the case is judged on what the family would get.
		for (
			let tries = 0;
			state.status === 'normalized' && state.attempt != null && tries < 5;
			tries++
		) {
			k.clock.advance(RETRY_WAIT_MS);
			await k.worker.drain();
			state = await read();
		}
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
			results: c.checks.map((check) => {
				const ok = check.pass(drafts, members, state, c.text, listed);
				return {
					check,
					ok,
					failure: ok
						? null
						: (check.failure?.(drafts, members, state, c.text, listed) ?? 'missed'),
				};
			}),
		};
	} finally {
		await k.close();
	}
}
