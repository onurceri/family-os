import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import { type LlmPort, systemActor } from '@famos/sdk';
import { type CaseVerdict, createTestKernel, runEval } from '@famos/testing';
import { defaultHourCycle, defaultWeekStart, epochOf, formatLocaleForLanguage } from '@famos/time';
import inbox from '../src/server/index.ts';
import { PROMPT_VERSION } from '../src/server/process.ts';
import { CASES, DEFAULT_FAMILY, type Draft, type Listed, type Members } from './cases.ts';

/**
 * Runs the extraction cases against real models and reports which checks pass, one column per
 * model. Not part of CI: it costs money and depends on the provider. Each case runs on its own
 * kernel. Usage (the other variables are described in `runEval` of `@famos/testing`):
 *   FAMOS_EVAL_API_KEY=… FAMOS_EVAL_MODELS=openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini \
 *   [FAMOS_EVAL_CASE=substring] pnpm --filter @famos/ext-inbox eval
 */
async function runCase(c: (typeof CASES)[number], llm: LlmPort): Promise<CaseVerdict> {
	const lines: string[] = [];
	// The records area only for cases that bring duties, so the other cases keep their catalog.
	const k = await createTestKernel({
		extensions: c.obligations ? [calendar, lists, records, inbox] : [calendar, lists, inbox],
		llm,
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
		const results = c.checks.map((check) => ({
			check,
			ok: check.pass(drafts, members, state, c.text, listed),
		}));
		const ok = state.status === 'extracted' && results.every((r) => r.ok);
		lines.push(
			`${ok ? '✓' : '✗'} ${c.name}${state.status === 'extracted' ? '' : ` [${state.status}: ${state.errorCode}]`}${state.skipped ? ` (${state.skipped} skipped)` : ''}`,
		);
		for (const r of results.filter((r) => !r.ok)) lines.push(`    ✗ ${r.check.label}`);
		if (!ok || process.env.FAMOS_EVAL_VERBOSE) {
			const names = Object.fromEntries(Object.entries(members).map(([n, id]) => [id, n]));
			for (const d of drafts) {
				const shown = JSON.stringify(d.input, (_k, v) =>
					typeof v === 'string' && names[v] ? `@${names[v]}` : v,
				);
				lines.push(
					`      · ${d.actionId} ${shown}${d.uncertainFields.length ? ` check:${d.uncertainFields.join(',')}` : ''}${d.mayExist ? ' may-exist' : ''}`,
				);
			}
		}
		const failed = [
			...(state.status === 'extracted' ? [] : [`the item was read (${state.status})`]),
			...results.filter((r) => !r.ok).map((r) => r.check.label),
		];
		return { ok, checks: results.length, failed, lines };
	} finally {
		await k.close();
	}
}

process.exit(
	await runEval({
		title: 'Inbox extraction eval',
		version: PROMPT_VERSION,
		cases: CASES,
		run: runCase,
		dir: import.meta.dirname,
	}),
);
