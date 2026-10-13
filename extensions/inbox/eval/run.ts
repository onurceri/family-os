import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import { isLlmError, type LlmPort, systemActor } from '@famos/sdk';
import { createTestKernel, llmFromEnv } from '@famos/testing';
import { epochOf } from '@famos/time';
import inbox from '../src/server/index.ts';
import { PROMPT_VERSION } from '../src/server/process.ts';
import { CASES, DEFAULT_FAMILY, type Draft, type Listed, type Members } from './cases.ts';

/**
 * Runs the extraction cases against a real model and reports which checks pass. Not part of CI:
 * it costs money and depends on the provider. Cases run in parallel (each on its own kernel), so
 * the run takes about as long as the slowest case. Usage:
 *   FAMOS_EVAL_API_KEY=… [FAMOS_EVAL_MODEL=…] [FAMOS_EVAL_CASE=substring] pnpm --filter @famos/ext-inbox eval
 */
const env = await llmFromEnv();
if (!env) {
	console.error(
		'Set FAMOS_EVAL_API_KEY (and optionally FAMOS_EVAL_MODEL, FAMOS_EVAL_PROVIDER, FAMOS_EVAL_BASE_URL).',
	);
	process.exit(2);
}
const only = process.env.FAMOS_EVAL_CASE?.toLowerCase();
const cases = CASES.filter((c) => !only || c.name.toLowerCase().includes(only));
console.log(`Inbox extraction eval · ${env.label} · ${PROMPT_VERSION} · ${cases.length} cases\n`);

const llm = env.llm;

/** The model, recording how long the case's call took and why it failed. */
function observed(): { llm: LlmPort; notes: string[] } {
	const notes: string[] = [];
	return {
		notes,
		llm: {
			policy: (feature, role) => llm.policy(feature, role),
			transcribe: (request) => llm.transcribe(request),
			embed: (request) => llm.embed(request),
			chat: (request) => llm.chat(request),
			async generateObject(request) {
				const started = Date.now();
				try {
					return await llm.generateObject(request);
				} catch (error) {
					notes.push(
						isLlmError(error) ? `${error.code}: ${error.message.slice(0, 160)}` : String(error),
					);
					throw error;
				} finally {
					notes.push(`${((Date.now() - started) / 1000).toFixed(1)}s`);
				}
			},
		},
	};
}

type Outcome = { ok: boolean; checks: number; failed: number; lines: string[] };

async function runCase(c: (typeof cases)[number]): Promise<Outcome> {
	const model = observed();
	const lines: string[] = [];
	// The records area only for cases that bring duties, so the other cases keep their catalog.
	const k = await createTestKernel({
		extensions: c.obligations ? [calendar, lists, records, inbox] : [calendar, lists, inbox],
		llm: model.llm,
	});
	try {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: c.timeZone ?? 'UTC', locale: c.locale ?? 'en' },
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
			`${ok ? '✓' : '✗'} ${c.name}${state.status === 'extracted' ? '' : ` [${state.status}: ${state.errorCode}]`}${state.skipped ? ` (${state.skipped} skipped)` : ''} · ${model.notes.join(' · ')}`,
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
		const failed = results.filter((r) => !r.ok).length;
		return { ok, checks: results.length, failed, lines };
	} finally {
		await k.close();
	}
}

const started = Date.now();
const outcomes = await Promise.all(cases.map(runCase));
for (const o of outcomes) for (const line of o.lines) console.log(line);
const passed = outcomes.filter((o) => o.ok).length;
const checks = outcomes.reduce((n, o) => n + o.checks, 0);
const failedChecks = outcomes.reduce((n, o) => n + o.failed, 0);
const usage = await env.usage();
console.log(
	`\n${passed}/${cases.length} cases passed · ${checks - failedChecks}/${checks} checks · ${usage.total.calls} calls · $${usage.total.cost.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
process.exit(passed === cases.length ? 0 : 1);
