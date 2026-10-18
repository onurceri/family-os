import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type DigestOutput,
	type ExtensionDefinition,
	isLlmError,
	type LlmPort,
	parseManifest,
} from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { dateWords, numericDateOrder, weekdayMismatches } from '@famos/time';
import type { AnswerCard } from '../src/contract/index.ts';
import { leadSystem } from '../src/server/lead.ts';
import { systemPrompt } from '../src/server/prompt.ts';
import { UNDERSTAND_VERSION, understandHash } from '../src/server/understand.ts';
import {
	ALWAYS,
	type Call,
	type Check,
	type Draft,
	type Outcome,
	questionChecks,
	type Truth,
	type Turn,
} from './checks.ts';
import { type Case, DEFAULT_TIME_ZONE, seed, TODAY } from './seed.ts';

/** `calendar_findEvents` → `calendar.findEvents`: the host replaces the first dot of an action id. */
export const actionIdOf = (toolName: string) => toolName.replace('_', '.');

/** What the eval's prompt is, for its baseline and recordings. */
export const EVAL_VERSION = UNDERSTAND_VERSION;

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Longer than any backoff of the queue between two tries of a job. */
const RETRY_WAIT_MS = 60_000;

let bundled: Promise<ExtensionDefinition[]> | undefined;

/**
 * Every extension the app ships, always installed or offered, as a family that installed them
 * all has them: the assistant is then asked with every tool and topic a real family can have.
 * They are loaded from their workspace folders by the list the app ships (`extensions.json`)
 * rather than imported by name, since several of them depend on others only for their tests.
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

/** The household's extensions for a case: every shipped one but those it leaves out. */
async function extensionsOf(c: Case): Promise<ExtensionDefinition[]> {
	const left = new Set(c.notInstalled ?? []);
	return (await bundledExtensions()).filter((e) => !left.has(e.manifest.id));
}

/**
 * The model, recording every tool call with its input, how long each turn took and why it failed.
 * The product's own limits (steps, tool calls, timeout) stay as the turn sets them.
 */
export function observed(llm: LlmPort, raw = false) {
	const calls: Call[] = [];
	const notes: string[] = [];
	const timed = async <T>(work: () => Promise<T>): Promise<T> => {
		const started = Date.now();
		try {
			return await work();
		} catch (error) {
			notes.push(
				isLlmError(error) ? `${error.code}: ${error.message.slice(0, 160)}` : String(error),
			);
			throw error;
		} finally {
			notes.push(`${((Date.now() - started) / 1000).toFixed(1)}s`);
		}
	};
	const port: LlmPort = {
		policy: (feature, role) => llm.policy(feature, role),
		transcribe: (request) => llm.transcribe(request),
		embed: (request) => llm.embed(request),
		generateObject: (request) =>
			timed(async () => {
				const result = await llm.generateObject(request);
				if (raw) notes.push(`raw reading ${JSON.stringify(result.output)}`);
				return result;
			}),
		chat(request) {
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
			return timed(async () => {
				const result = await llm.chat({ ...request, tools });
				// What the model wrote, before the host turns handles into names or checks it.
				if (raw) notes.push(`raw answer ${JSON.stringify(result.text)}`);
				return result;
			});
		},
	};
	return { llm: port, calls, notes };
}

type PackagesPort = NonNullable<Parameters<typeof createTestKernel>[0]>['extensionPackages'];

/**
 * The packages of extensions shipped in this repository that a case leaves uninstalled, read like
 * the server reads its bundled ones (the manifest, and the name and description of each catalog),
 * so the assistant knows they exist and are not here.
 */
export function notInstalledPackages(ids: readonly string[]): PackagesPort {
	const root = join(import.meta.dirname, '../..');
	const list = ids.map((id) => {
		const dir = join(root, id);
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
			famos: Parameters<typeof parseManifest>[0];
		};
		const manifest = parseManifest(pkg.famos);
		const labels: Record<string, { name: string; description: string }> = {};
		for (const file of readdirSync(join(dir, 'src/messages')).filter((f) => f.endsWith('.json'))) {
			const catalog = JSON.parse(readFileSync(join(dir, 'src/messages', file), 'utf8')) as Record<
				string,
				string
			>;
			if (catalog.feature_name && catalog.feature_description)
				labels[file.slice(0, -'.json'.length)] = {
					name: catalog.feature_name,
					description: catalog.feature_description,
				};
		}
		return { id: manifest.id, version: manifest.version, always: false, manifest, labels };
	});
	return {
		list: () => list,
		place: () => Promise.reject(new Error('The eval installs nothing')),
	};
}

/** Typographic quotes as plain ones (U+2018, U+2019). */
const CURLY_QUOTES = /[‘’]/g;
/** No-break and thin spaces as plain ones (U+00A0, U+2007, U+2009, U+202F). */
const ODD_SPACES = /[    ]/g;

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

/** The checks a case is judged by: its own, those of its question, then those of every case. */
export const checksOf = (c: Case): Check[] => [
	...c.checks,
	...(c.expect ? questionChecks(c.expect) : []),
	...ALWAYS,
];

/** What the card of a question had to show: each expected topic's digest, read as the asker. */
async function truthOf(
	k: TestKernel,
	c: Case,
	asker: Awaited<ReturnType<TestKernel['member']>>,
	seeded: Record<string, string>,
): Promise<Truth[] | undefined> {
	const expected = c.expect;
	if (!expected) return undefined;
	const digests = k.ctx.actions.aiDigests({ local: true });
	const memberIds = (expected.people ?? []).map((name) => seeded[name] as string);
	const out: Truth[] = [];
	for (const topic of expected.topics) {
		const digest = digests.find((d) => d.topic === topic);
		if (!digest) continue;
		const result = await k.runner.invoke<DigestOutput>(
			digest.actionId,
			{ from: expected.from, to: expected.to, ...(memberIds.length && { memberIds }) },
			asker.actor,
		);
		if (result.status !== 'applied') continue;
		out.push({
			topic,
			items: result.output.items.map((i) => ({
				title: i.title,
				date: i.date,
				standing:
					['shopping_list', 'note', 'suggestion'].includes(i.kind) || i.extra?.undated === 'yes',
			})),
		});
	}
	return out;
}

export interface RunOptions {
	/** A real model; without one the kernel's fake answers, as `prepare` scripts it. */
	llm?: LlmPort;
	prepare?: (k: TestKernel) => void;
	raw?: boolean;
}

/**
 * Runs one case on its own kernel, in a household with every shipped extension (but those the
 * case leaves out): seeds it, sends each message through `assistant.sendMessage` and runs the turn
 * job (the same code and tools as in the app), then collects the calls, drafts, cards and answers
 * and applies the checks.
 */
export async function runCase(c: Case, options: RunOptions = {}): Promise<CaseResult> {
	const model = options.llm ? observed(options.llm, options.raw) : null;
	const k = await createTestKernel({
		extensions: await extensionsOf(c),
		...(model && { llm: model.llm }),
		translate: repoTranslate(),
		...(c.notInstalled && { extensionPackages: notInstalledPackages(c.notInstalled) }),
	});
	try {
		const { seeded, asker } = await seed(k, c);
		options.prepare?.(k);
		const settings = await k.ctx.family.settings();
		const words = dateWords((key) => k.ctx.vocabulary(key));
		const order = numericDateOrder(settings.formatLocale);
		const today = c.today ?? TODAY;
		const turns: Turn[] = [];
		let threadId: string | undefined;
		for (const ask of c.asks) {
			const before = model ? model.calls.length : k.llm.chatTrace.length;
			const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
				'assistant.sendMessage',
				{ text: ask, ...(threadId && { threadId }) },
				asker.actor,
			);
			if (sent.status !== 'applied') throw new Error('The message was not stored');
			threadId = sent.output.threadId;
			const readReply = async () => {
				const detail = await k
					.route('assistant.getThread')
					.call({ params: { threadId }, actor: asker.actor });
				return (
					detail.messages as {
						id: string;
						content: string;
						suggested: string[];
						card: AnswerCard | null;
						toolCalls: { name: string }[];
						status: string;
						errorCode: string | null;
					}[]
				).find((m) => m.id === sent.output.replyId);
			};
			await k.worker.drain();
			let reply = await readReply();
			// A turn that failed in a way worth another try is tried again after the queue's
			// backoff, as at home: the answer is judged once the queue is done with it.
			for (let tries = 0; tries < 3 && reply?.status === 'pending'; tries++) {
				k.clock.advance(RETRY_WAIT_MS);
				await k.worker.drain();
				reply = await readReply();
			}
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
			const card = reply?.card ?? null;
			const loopCalls: Call[] = model
				? model.calls.slice(before)
				: k.llm.chatTrace.slice(before).map((t) => ({
						actionId: actionIdOf(t.tool),
						input: (t.input ?? {}) as Record<string, unknown>,
					}));
			// A card's reads are digests, which the model never calls: the stored answer lists them.
			const reads: Call[] = card
				? (reply?.toolCalls ?? []).map((t) => ({ actionId: t.name, input: {} }))
				: [];
			// The words of the answer, the card's lines and the app's line for each suggestion, as a
			// chat outside the app shows them, in plain typography (see `plainText`).
			const shown = plainText(
				[reply?.content ?? '', (card?.text ?? []).join('\n'), (reply?.suggested ?? []).join('\n')]
					.filter((part) => part !== '')
					.join('\n\n'),
			);
			const own = new Set(
				weekdayMismatches(ask, today, words, order).map((m) => `${m.date}:${m.saidWeekday}`),
			);
			turns.push({
				ask,
				reply: shown,
				status:
					reply?.status === 'failed'
						? `failed: ${reply.errorCode ?? 'unknown'}`
						: (reply?.status ?? 'missing'),
				calls: [...reads, ...loopCalls],
				drafts,
				card,
				lead: card ? (reply?.content ?? '') : '',
				...(card && { truth: await truthOf(k, c, asker, seeded) }),
				weekdaySlips: weekdayMismatches(shown, today, words, order).filter(
					(m) => !own.has(`${m.date}:${m.saidWeekday}`),
				).length,
			});
			// The next message comes a minute later, as a person would write it.
			k.clock.advance(60_000);
		}
		const outcome: Outcome = {
			turns,
			seeded,
			timeZone: c.timeZone ?? DEFAULT_TIME_ZONE,
			asker: asker.member.displayName,
		};
		const checks = checksOf(c);
		const failed = checks.filter((check) => !safePass(check, outcome)).map((check) => check.label);
		return {
			name: c.name,
			ok: failed.length === 0,
			checks: checks.length,
			failed,
			outcome,
			notes: model?.notes ?? [],
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

/**
 * A fingerprint of everything the model is asked besides the family's data: the reading's rules,
 * examples and schema, the wording call's instructions, the tool loop's instructions with
 * placeholders, and every tool a household with every shipped extension offers. The baseline and
 * the recordings keep it; when it changes, the eval has to run again.
 */
export async function casesPromptHash(): Promise<string> {
	const k = await createTestKernel({ extensions: await bundledExtensions() });
	try {
		const tools = [...k.ctx.actions.aiReadTools(), ...k.ctx.actions.aiCatalog()].map((t) => ({
			id: t.id,
			description: t.description,
			guidance: t.guidance ?? null,
			input: t.inputSchema,
		}));
		const lead = [false, true].map((young) =>
			leadSystem({
				asker: { name: '{name}', about: '{about}' },
				language: '{language}',
				budget: { sentences: young ? 1 : 2, young },
			}),
		);
		const loop = systemPrompt({
			today: '2026-01-05',
			weekday: 'Monday',
			now: '10:00',
			weekStart: 1,
			timeZone: '{timeZone}',
			locale: 'en',
			hourCycle: 'h23',
			asker: { name: '{name}', handle: 'member:1' },
			members: [{ handle: 'member:1', name: '{name}', about: '{about}' }],
			summary: '{summary}',
			hasTools: true,
			memories: ['{memory}'],
			records: [{ handle: 'record:1', label: '{label}' }],
			notes: ['{note}'],
			days: ['{day}'],
			areas: ['{area}'],
			missing: [{ id: '{id}', name: '{name}', description: '{description}', why: 'not_installed' }],
			vocabularies: [{ label: '{label}', words: ['{word}'] }],
		});
		return createHash('sha256')
			.update(understandHash())
			.update(JSON.stringify(lead))
			.update(loop)
			.update(JSON.stringify(tools))
			.digest('hex')
			.slice(0, 16);
	} finally {
		await k.close();
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
		if (turn.card)
			lines.push(
				`      · card ${JSON.stringify(turn.card.understood)}${turn.card.lead.check ? ` · opening dropped: ${turn.card.lead.check}` : ''}`,
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
