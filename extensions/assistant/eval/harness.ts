import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { isLlmError, type LlmPort } from '@famos/sdk';
import { createTestKernel, repoTranslate } from '@famos/testing';
import assistant from '../src/server/index.ts';
import { ALWAYS, type Call, type Check, type Draft, type Outcome, type Turn } from './checks.ts';
import { type Case, DEFAULT_TIME_ZONE, seed } from './seed.ts';

/** `calendar_findEvents` → `calendar.findEvents`: the host replaces the first dot of an action id. */
export const actionIdOf = (toolName: string) => toolName.replace('_', '.');

/**
 * The model, recording every tool call with its input, how long each turn took and why it failed.
 * The product's own limits (steps, tool calls, timeout) stay as the turn sets them.
 */
export function observed(llm: LlmPort, raw = false) {
	const calls: Call[] = [];
	const notes: string[] = [];
	const port: LlmPort = {
		policy: (feature, role) => llm.policy(feature, role),
		transcribe: (request) => llm.transcribe(request),
		embed: (request) => llm.embed(request),
		generateObject: (request) => llm.generateObject(request),
		async chat(request) {
			const started = Date.now();
			const tools = request.tools.map((tool) => ({
				...tool,
				async execute(input: unknown) {
					calls.push({
						actionId: actionIdOf(tool.name),
						input: (input ?? {}) as Record<string, unknown>,
					});
					const result = await tool.execute(input);
					// FAMOS_EVAL_RAW=1 also shows what each tool told the model.
					if (raw) notes.push(`raw ${tool.name} → ${String(result).slice(0, 400)}`);
					return result;
				},
			}));
			try {
				const result = await llm.chat({ ...request, tools });
				// What the model wrote, before the host turns handles into names.
				if (raw) notes.push(`raw answer ${JSON.stringify(result.text)}`);
				return result;
			} catch (error) {
				notes.push(
					isLlmError(error) ? `${error.code}: ${error.message.slice(0, 160)}` : String(error),
				);
				throw error;
			} finally {
				notes.push(`${((Date.now() - started) / 1000).toFixed(1)}s`);
			}
		},
	};
	return { llm: port, calls, notes };
}

/** Typographic quotes as plain ones (U+2018, U+2019). */
const CURLY_QUOTES = /[\u2018\u2019]/g;
/** No-break and thin spaces as plain ones (U+00A0, U+2007, U+2009, U+202F). */
const ODD_SPACES = /[\u00a0\u2007\u2009\u202f]/g;

/**
 * An answer in plain typography, so the checks' words match however a model types them: some
 * write "couldn’t" with a curly apostrophe, or a no-break space in "6 October".
 */
export const plainText = (text: string) => text.replace(CURLY_QUOTES, "'").replace(ODD_SPACES, ' ');

export interface CaseResult {
	name: string;
	ok: boolean;
	checks: number;
	failed: string[];
	outcome: Outcome;
	notes: string[];
}

/** The checks a case is judged by: its own, then the ones every case gets. */
export const checksOf = (c: Case): Check[] => [...c.checks, ...ALWAYS];

/**
 * Runs one case on its own kernel: seeds the household, sends each message through
 * `assistant.sendMessage` and runs the turn job (the same code and tools as in the app), then
 * collects the calls, drafts and answers and applies the checks.
 */
export async function runCase(c: Case, llm: LlmPort, raw = false): Promise<CaseResult> {
	const model = observed(llm, raw);
	const k = await createTestKernel({
		extensions: [calendar, lists, assistant],
		llm: model.llm,
		translate: repoTranslate(),
	});
	try {
		const { seeded, asker } = await seed(k, c);
		const turns: Turn[] = [];
		let threadId: string | undefined;
		for (const ask of c.asks) {
			const before = model.calls.length;
			const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
				'assistant.sendMessage',
				{ text: ask, ...(threadId && { threadId }) },
				asker.actor,
			);
			if (sent.status !== 'applied') throw new Error('The message was not stored');
			threadId = sent.output.threadId;
			await k.worker.drain();
			const detail = await k
				.route('assistant.getThread')
				.call({ params: { threadId }, actor: asker.actor });
			const reply = (
				detail.messages as {
					id: string;
					content: string;
					suggested: string[];
					status: string;
					errorCode: string | null;
				}[]
			).find((m) => m.id === sent.output.replyId);
			const drafts = (
				(await k.route('core.listDrafts').call({
					query: { sourceKind: 'assistant', sourceId: sent.output.replyId, limit: 200 },
					actor: asker.actor,
				})) as { actionId: string; input: unknown; mayExist: boolean }[]
			)
				.reverse()
				.map(
					(d): Draft => ({
						actionId: d.actionId,
						input: (d.input ?? {}) as Record<string, unknown>,
						mayExist: d.mayExist,
					}),
				);
			turns.push({
				ask,
				// The model's words with the app's line for each suggestion under them, as a chat
				// outside the app shows the answer, in plain typography (see `plainText`).
				reply: plainText(
					[reply?.content ?? '', ...(reply?.suggested.length ? [reply.suggested.join('\n')] : [])]
						.filter((part) => part !== '')
						.join('\n\n'),
				),
				status:
					reply?.status === 'failed'
						? `failed: ${reply.errorCode ?? 'unknown'}`
						: (reply?.status ?? 'missing'),
				calls: model.calls.slice(before),
				drafts,
			});
			// The next message comes a minute later, as a person would write it.
			k.clock.advance(60_000);
		}
		const outcome: Outcome = { turns, seeded, timeZone: c.timeZone ?? DEFAULT_TIME_ZONE };
		const checks = checksOf(c);
		const failed = checks.filter((check) => !safePass(check, outcome)).map((check) => check.label);
		return {
			name: c.name,
			ok: failed.length === 0,
			checks: checks.length,
			failed,
			outcome,
			notes: model.notes,
		};
	} finally {
		await k.close();
	}
}

/** A check that throws (a typo in a seeded title) fails rather than ending the run. */
function safePass(check: Check, outcome: Outcome): boolean {
	try {
		return check.pass(outcome);
	} catch {
		return false;
	}
}

/** Member ids shown as `@Name`, so a failed case reads without looking ids up. */
function readable(value: unknown, names: Record<string, string>): string {
	return JSON.stringify(value, (_k, v) => (typeof v === 'string' && names[v] ? `@${names[v]}` : v));
}

/** The report of one case: a line, and for a failed case its checks, calls, drafts and replies. */
export function report(result: CaseResult, verbose = false): string[] {
	const lines = [`${result.ok ? '✓' : '✗'} ${result.name} · ${result.notes.join(' · ')}`];
	for (const label of result.failed) lines.push(`    ✗ ${label}`);
	if (result.ok && !verbose) return lines;
	const names = Object.fromEntries(Object.entries(result.outcome.seeded).map(([n, id]) => [id, n]));
	for (const turn of result.outcome.turns) {
		lines.push(
			`      · asked ${JSON.stringify(turn.ask)}${turn.status === 'done' ? '' : ` [${turn.status}]`}`,
		);
		for (const call of turn.calls)
			lines.push(`      · call ${call.actionId} ${JSON.stringify(call.input)}`);
		for (const draft of turn.drafts)
			lines.push(
				`      · draft ${draft.actionId} ${readable(draft.input, names)}${draft.mayExist ? ' may-exist' : ''}`,
			);
		lines.push(`      · reply ${JSON.stringify(turn.reply)}`);
	}
	return lines;
}
