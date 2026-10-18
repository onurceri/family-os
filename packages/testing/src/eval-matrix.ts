import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isLlmError, type LlmPort } from '@famos/sdk';
import { type EnvCall, type EnvLlm, llmsFromEnv, slugOf } from './llm-from-env.ts';

/**
 * Runs evaluation cases against several real models and reports them side by side. Used by the
 * evals of the extensions (`pnpm --filter @famos/ext-inbox eval`), never by tests: they cost
 * money and depend on the provider. The environment:
 *
 * - `FAMOS_EVAL_MODELS` / `FAMOS_EVAL_MODEL` …: the models (see `llmsFromEnv`).
 * - `FAMOS_EVAL_CASE=substring`: only the cases whose name contains it.
 * - `FAMOS_EVAL_RUNS=n`: every case runs n times on each model (default 1). The report gives each
 *   case's pass count out of n and each model's median pass rate over the runs; the baseline keeps
 *   the pass counts. A model's answers are recorded from the first run the provider did not
 *   break (the first run when it broke them all).
 * - `FAMOS_EVAL_CONCURRENCY=n`: at most n cases at once over all models (default: all at once).
 * - `FAMOS_EVAL_MAX_COST=usd`: no case starts once the finished ones cost this much.
 * - `FAMOS_EVAL_REPORT=path`: writes the whole result as JSON.
 * - `FAMOS_EVAL_RECORD=1` (or a folder): saves each model's answers per case under
 *   `<eval folder>/recorded/<model>/<case>.json`. The cases are made up, never family data.
 * - `FAMOS_EVAL_BASELINE=1`: writes `<eval folder>/baseline.json` for the models of a full run.
 * - `FAMOS_EVAL_RAW=1`: shows every answer, and the text of an answer the app refused.
 * - `FAMOS_EVAL_VERBOSE=1`: passed to the case runner, which shows more of passed cases.
 * - `FAMOS_EVAL_ZERO_RETENTION=1`: limits OpenRouter to providers that keep no data, as a family
 *   can choose to; most free models are then unavailable. Off by default, as for a new family.
 */

/** A model's answer as a fake model replays it. */
export type RecordedAnswer =
	| { kind: 'object'; feature: string; output: unknown }
	| { kind: 'object'; feature: string; error: string; text?: string }
	| {
			kind: 'chat';
			feature: string;
			text: string;
			toolCalls: { name: string; input: unknown }[];
	  }
	| { kind: 'chat'; feature: string; error: string; toolCalls: { name: string; input: unknown }[] };

/** One call a case made, with what the adapter measured. */
export interface CallRecord extends Omit<EnvCall, 'feature'> {
	answer: RecordedAnswer;
}

/** How a case went for one model, as its runner judged it. */
export interface CaseVerdict {
	ok: boolean;
	checks: number;
	/** Labels of the failed checks. */
	failed: string[];
	/**
	 * Of those, the harmful ones: a wrong value shown as certain, or a wrong thing acted on. The
	 * rest of the failed checks are missed ones: refused, skipped, or shown as unsure.
	 */
	harmful?: string[];
	/** What to print about the case, its first line starting with ✓ or ✗. */
	lines: string[];
}

export interface Cell {
	case: string;
	model: string;
	/**
	 * `outage`: the case failed and the provider failed on its side in it (see `OUTAGES`), so it
	 * says nothing about the model and counts neither way.
	 */
	status: 'passed' | 'failed' | 'outage' | 'skipped';
	checks: number;
	/** The distinct labels of the checks that failed in any run. */
	failed: string[];
	/** The distinct labels of the failed checks that were harmful. */
	harmful: string[];
	/** Failed checks over all runs that were missed, and that were harmful (outages count none). */
	missedChecks: number;
	harmfulChecks: number;
	/** How many runs were made, how many of them passed, and how each one went. */
	runs: number;
	passes: number;
	runStatuses: ('passed' | 'failed' | 'outage')[];
	calls: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cost: number;
	latencyMs: number;
	finishReasons: string[];
	errors: string[];
	/** The output modes of the case's structured calls; `schema>json` when one fell back. */
	outputModes: string[];
}

export interface ModelTotals {
	slug: string;
	label: string;
	cases: number;
	passed: number;
	skipped: number;
	/** Cases the provider's own failure ended (`Cell.status` `outage`). */
	outages: number;
	checks: number;
	failedChecks: number;
	/** Failed checks over all runs, by class (see `CaseVerdict.harmful`). The gate is no harmful ones. */
	missed: number;
	harmful: number;
	/** Runs made of every case. */
	runs: number;
	/** The median over the runs of the share of cases that passed in that run, or null if none. */
	medianPassRate: number | null;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	/** Of the slowest case. */
	slowestMs: number;
}

export interface MatrixResult {
	title: string;
	version: string | null;
	at: string;
	models: ModelTotals[];
	cells: Cell[];
}

export interface BaselineEntry {
	label: string;
	version: string | null;
	/**
	 * The fingerprint of what the model was asked in that run (the eval's `promptHash`). A test
	 * compares it with today's, so a change to the prompt cannot go out without a new run.
	 */
	promptHash?: string;
	/** YYYY-MM-DD of the run. */
	date: string;
	cases: number;
	passing: string[];
	/** Failing cases with the labels of their failed checks (of any run). */
	failing: Record<string, string[]>;
	/** Runs made of each case, and how many of them each case passed (outages left out). */
	runs?: number;
	passCounts?: Record<string, number>;
	/** The harmful failed checks by case; none is the gate. */
	harmful?: Record<string, string[]>;
	/** Cases the provider's own failure ended in that run: neither passing nor failing. */
	outages?: string[];
	cost: number;
}

/** Per model slug, from the last full matrix run that was kept. */
export interface Baseline {
	models: Record<string, BaselineEntry>;
}

/**
 * Failures of the provider or the setup rather than of the model's answer. A run that had one is
 * no measure of the model, so it never becomes the baseline. A timeout counts against the model:
 * the product's own limit ended a turn that kept calling tools.
 */
const OUTAGES: ReadonlySet<string> = new Set([
	'unavailable',
	'auth',
	'limit_reached',
	'not_configured',
	'rejected',
	'data_policy',
]);

let tags = 0;

const OUTAGE_WAIT_MS = 15_000;
/** Kept under the time a job gets, since the wait happens inside the job that made the call. */
export const OUTAGE_WAIT_MAX_MS = 90_000;

/**
 * The model of one case, recording every call: its answer, and the tokens, cost, time and
 * finish reason the adapter wrote down for it (found again by a `jobId` of its own).
 *
 * A call the provider could not serve (`unavailable`: a rate limit, a dropped connection) still
 * fails, as it would at home, so the job that made it tries again after its backoff; but first
 * the real time passes that the provider asked for, or longer after each such failure in a row.
 * Free models' tight limits then end in an answer or in an outage, never in a failure of the
 * model.
 */
export function observe(env: EnvLlm, raw = false, wait: (ms: number) => Promise<unknown> = sleep) {
	const calls: CallRecord[] = [];
	const notes: string[] = [];
	let inRow = 0;
	const afterFailure = async (error: unknown) => {
		if (!isLlmError(error) || error.code !== 'unavailable') return;
		const ms = Math.min(
			Math.max(error.retryAfterMs ?? 0, OUTAGE_WAIT_MS * 2 ** inRow++),
			OUTAGE_WAIT_MAX_MS,
		);
		notes.push(`provider unavailable; waiting ${Math.round(ms / 1000)}s before the next try`);
		await wait(ms);
	};
	const measured = async (jobId: string, answer: RecordedAnswer) => {
		const rows = await env.calls(jobId);
		calls.push({ ...sumCalls(rows), answer });
	};
	const llm: LlmPort = {
		policy: (feature, role) => env.llm.policy(feature, role),
		transcribe: (request) => env.llm.transcribe(request),
		embed: (request) => env.llm.embed(request),
		async generateObject(request) {
			const jobId = `eval_${++tags}`;
			try {
				const result = await env.llm.generateObject({ ...request, jobId });
				inRow = 0;
				if (raw) notes.push(`raw ${JSON.stringify(result.output)}`);
				await measured(jobId, { kind: 'object', feature: request.feature, output: result.output });
				return result;
			} catch (error) {
				const text = refusedText(error);
				notes.push(failure(error));
				if (raw && text !== undefined) notes.push(`raw text ${text.length} chars: ${text}`);
				await measured(jobId, {
					kind: 'object',
					feature: request.feature,
					error: isLlmError(error) ? error.code : 'error',
					...(text !== undefined && { text }),
				});
				await afterFailure(error);
				throw error;
			}
		},
		async chat(request) {
			const jobId = `eval_${++tags}`;
			const toolCalls: { name: string; input: unknown }[] = [];
			const tools = request.tools.map((tool) => ({
				...tool,
				execute(input: unknown) {
					toolCalls.push({ name: tool.name, input });
					return tool.execute(input);
				},
			}));
			try {
				const result = await env.llm.chat({ ...request, tools, jobId });
				inRow = 0;
				await measured(jobId, {
					kind: 'chat',
					feature: request.feature,
					text: result.text,
					toolCalls,
				});
				return result;
			} catch (error) {
				notes.push(failure(error));
				await measured(jobId, {
					kind: 'chat',
					feature: request.feature,
					error: isLlmError(error) ? error.code : 'error',
					toolCalls,
				});
				await afterFailure(error);
				throw error;
			}
		},
	};
	return { llm, calls, notes };
}

function failure(error: unknown): string {
	if (!isLlmError(error)) return `call failed: ${String(error)}`;
	const used = error.usage
		? ` (${error.usage.inputTokens ?? '?'} in, ${error.usage.outputTokens ?? '?'} out, ${error.usage.finishReason ?? 'no finish reason'})`
		: '';
	return `call failed: ${error.code}: ${error.message.slice(0, 160)}${used}`;
}

/** The text a model wrote before the app refused it as the wrong structure, when there was one. */
function refusedText(error: unknown): string | undefined {
	if (!isLlmError(error)) return undefined;
	const text = (error.cause as { text?: unknown } | undefined)?.text;
	return typeof text === 'string' ? text : undefined;
}

/** Calls of one request (a retry or a fallback is a second row) as one. */
export function sumCalls(rows: readonly Omit<EnvCall, 'feature'>[]): Omit<EnvCall, 'feature'> {
	const sum = (pick: (r: Omit<EnvCall, 'feature'>) => number | null) =>
		rows.some((r) => pick(r) !== null) ? rows.reduce((n, r) => n + (pick(r) ?? 0), 0) : null;
	const last = rows.at(-1);
	return {
		inputTokens: sum((r) => r.inputTokens),
		outputTokens: sum((r) => r.outputTokens),
		reasoningTokens: sum((r) => r.reasoningTokens),
		cost: sum((r) => r.cost),
		latencyMs: rows.reduce((n, r) => n + r.latencyMs, 0),
		finishReason: last?.finishReason ?? null,
		errorCode: last?.errorCode ?? null,
		// The modes in the order they were tried; a retry in the same mode is not a new step.
		outputMode:
			rows
				.map((r) => r.outputMode)
				.filter((m, i, all): m is string => m !== null && m !== all[i - 1])
				.join('>') || null,
	};
}

/** A case's cell from its verdict and the calls it made. */
export function cellOf(
	name: string,
	model: string,
	verdict: CaseVerdict | null,
	calls: readonly CallRecord[],
): Cell {
	const reasons = new Set<string>();
	const errors = new Set<string>();
	const modes = new Set<string>();
	for (const c of calls) {
		if (c.finishReason) reasons.add(c.finishReason);
		if (c.errorCode) errors.add(c.errorCode);
		if (c.outputMode) modes.add(c.outputMode);
	}
	const status: Cell['status'] =
		verdict === null
			? 'skipped'
			: verdict.ok
				? 'passed'
				: [...errors].some((e) => OUTAGES.has(e))
					? 'outage'
					: 'failed';
	// What failed in a run the provider broke says nothing about the model: no check of it counts,
	// neither as missed nor as harmful, nor as a failure the baseline keeps.
	const failed = status === 'outage' ? [] : (verdict?.failed ?? []);
	const harmful = status === 'failed' ? failed.filter((l) => verdict?.harmful?.includes(l)) : [];
	return {
		case: name,
		model,
		status,
		checks: verdict?.checks ?? 0,
		failed,
		harmful,
		missedChecks: status === 'failed' ? failed.length - harmful.length : 0,
		harmfulChecks: harmful.length,
		runs: status === 'skipped' ? 0 : 1,
		passes: status === 'passed' ? 1 : 0,
		runStatuses: status === 'skipped' ? [] : [status],
		calls: calls.length,
		inputTokens: calls.reduce((n, c) => n + (c.inputTokens ?? 0), 0),
		outputTokens: calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0),
		reasoningTokens: calls.reduce((n, c) => n + (c.reasoningTokens ?? 0), 0),
		cost: calls.reduce((n, c) => n + (c.cost ?? 0), 0),
		latencyMs: calls.reduce((n, c) => n + c.latencyMs, 0),
		finishReasons: [...reasons],
		errors: [...errors],
		outputModes: [...modes],
	};
}

/**
 * The runs of one case on one model as one cell: it passed when every run that was not an
 * outage passed, and the counts and costs are the runs' together (the time is the slowest run's).
 */
export function mergeRuns(runs: readonly Cell[]): Cell {
	const played = runs.filter((r) => r.status !== 'skipped');
	const first = played[0];
	if (!first || played.length === 1) return first ?? (runs[0] as Cell);
	const sum = (pick: (c: Cell) => number) => played.reduce((n, c) => n + pick(c), 0);
	const union = (pick: (c: Cell) => string[]) => [...new Set(played.flatMap(pick))];
	const measured = played.filter((r) => r.status !== 'outage');
	return {
		...first,
		status:
			measured.length === 0
				? 'outage'
				: measured.every((r) => r.status === 'passed')
					? 'passed'
					: 'failed',
		checks: sum((c) => c.checks),
		failed: union((c) => c.failed),
		harmful: union((c) => c.harmful),
		missedChecks: sum((c) => c.missedChecks),
		harmfulChecks: sum((c) => c.harmfulChecks),
		runs: played.length,
		passes: sum((c) => c.passes),
		runStatuses: played.flatMap((c) => c.runStatuses),
		calls: sum((c) => c.calls),
		inputTokens: sum((c) => c.inputTokens),
		outputTokens: sum((c) => c.outputTokens),
		reasoningTokens: sum((c) => c.reasoningTokens),
		cost: sum((c) => c.cost),
		latencyMs: Math.max(...played.map((c) => c.latencyMs)),
		finishReasons: union((c) => c.finishReasons),
		errors: union((c) => c.errors),
		outputModes: union((c) => c.outputModes),
	};
}

const median = (values: readonly number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * The share of cases that passed in each run (outages and runs not made left out), and their
 * median: one run's luck does not decide a model's rate.
 */
export function medianPassRate(cells: readonly Cell[]): number | null {
	const runs = Math.max(0, ...cells.map((c) => c.runStatuses.length));
	const rates: number[] = [];
	for (let i = 0; i < runs; i++) {
		const statuses = cells.map((c) => c.runStatuses[i]).filter((s) => s && s !== 'outage');
		if (statuses.length > 0)
			rates.push(statuses.filter((s) => s === 'passed').length / statuses.length);
	}
	return median(rates);
}

/**
 * Runs `work` on every item, at most `limit` at once, in order. An item is skipped (its result
 * `null`) when `mayStart` says no at the moment it would start.
 */
export async function runPool<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<R>,
	mayStart: () => boolean = () => true,
): Promise<(R | null)[]> {
	const results: (R | null)[] = items.map(() => null);
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const index = next++;
			if (!mayStart()) continue;
			results[index] = await work(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
	return results;
}

export function totalsOf(model: EnvLlm, cells: readonly Cell[]): ModelTotals {
	const own = cells.filter((c) => c.model === model.slug);
	return {
		slug: model.slug,
		label: model.label,
		cases: own.length,
		passed: own.filter((c) => c.status === 'passed').length,
		skipped: own.filter((c) => c.status === 'skipped').length,
		outages: own.filter((c) => c.status === 'outage').length,
		checks: own.reduce((n, c) => n + c.checks, 0),
		failedChecks: own.reduce((n, c) => n + c.missedChecks + c.harmfulChecks, 0),
		missed: own.reduce((n, c) => n + c.missedChecks, 0),
		harmful: own.reduce((n, c) => n + c.harmfulChecks, 0),
		runs: Math.max(0, ...own.map((c) => c.runs)),
		medianPassRate: medianPassRate(own),
		calls: own.reduce((n, c) => n + c.calls, 0),
		inputTokens: own.reduce((n, c) => n + c.inputTokens, 0),
		outputTokens: own.reduce((n, c) => n + c.outputTokens, 0),
		cost: own.reduce((n, c) => n + c.cost, 0),
		slowestMs: own.reduce((n, c) => Math.max(n, c.latencyMs), 0),
	};
}

const tokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * One cell of the table: verdict, tokens in/out, cost, time, how the model stopped (a dash when
 * the adapter did not record it, as for chats) and the output modes of its structured calls.
 */
export function formatCell(cell: Cell): string {
	if (cell.status === 'skipped') return '- skipped';
	const stop = [...cell.finishReasons, ...cell.errors].join('+') || '-';
	const modes = cell.outputModes.length ? ` ${cell.outputModes.join(',')}` : '';
	const mark = cell.status === 'passed' ? '✓' : cell.status === 'outage' ? '! outage' : '✗';
	// Several runs: how many of them passed.
	const counted = cell.runs > 1 ? ` ${cell.passes}/${cell.runs}` : '';
	return `${mark}${counted} ${tokens(cell.inputTokens)}/${tokens(cell.outputTokens)} ${usd(cell.cost)} ${seconds(cell.latencyMs)} ${stop}${modes}`;
}

/** The table: one row per case and one column per model, then the totals of each model. */
export function formatTable(
	cases: readonly string[],
	models: readonly ModelTotals[],
	cells: readonly Cell[],
): string[] {
	const byKey = new Map(cells.map((c) => [`${c.model}\n${c.case}`, c]));
	const width = Math.min(56, Math.max(13, ...cases.map((c) => c.length)));
	const name = (text: string) =>
		text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
	const rows: string[][] = [
		['case', ...models.map((m) => m.label)],
		...cases.map((c) => [
			c,
			...models.map((m) => {
				const cell = byKey.get(`${m.slug}\n${c}`);
				return cell ? formatCell(cell) : '';
			}),
		]),
		[
			'passed',
			...models.map(
				(m) =>
					`${m.passed}/${m.cases}${m.outages ? ` (${m.outages} outage${m.outages > 1 ? 's' : ''})` : ''}${m.skipped ? ` (${m.skipped} skipped)` : ''}`,
			),
		],
		...(models.some((m) => m.runs > 1)
			? [
					[
						'pass rate',
						...models.map((m) =>
							m.medianPassRate === null
								? '-'
								: `median ${Math.round(m.medianPassRate * 100)}% of ${m.runs} runs`,
						),
					],
				]
			: []),
		['checks', ...models.map((m) => `${m.checks - m.failedChecks}/${m.checks}`)],
		['missed', ...models.map((m) => String(m.missed))],
		['harmful', ...models.map((m) => String(m.harmful))],
		['calls', ...models.map((m) => String(m.calls))],
		['tokens in/out', ...models.map((m) => `${tokens(m.inputTokens)}/${tokens(m.outputTokens)}`)],
		['cost', ...models.map((m) => usd(m.cost))],
		['slowest case', ...models.map((m) => seconds(m.slowestMs))],
	];
	const widths = models.map((_, i) => Math.max(...rows.map((r) => (r[i + 1] ?? '').length)));
	const line = (r: string[]) =>
		[name(r[0] ?? ''), ...widths.map((w, i) => (r[i + 1] ?? '').padEnd(w))].join(' │ ').trimEnd();
	const rule = ['─'.repeat(width), ...widths.map((w) => '─'.repeat(w))].join('─┼─');
	return [
		line(rows[0] as string[]),
		rule,
		...rows.slice(1, cases.length + 1).map(line),
		rule,
		...rows.slice(cases.length + 1).map(line),
	];
}

export function baselineEntry(
	totals: ModelTotals,
	cells: readonly Cell[],
	version: string | null,
	date: string,
	promptHash?: string,
): BaselineEntry {
	const own = cells.filter((c) => c.model === totals.slug);
	return {
		label: totals.label,
		version,
		...(promptHash !== undefined && { promptHash }),
		date,
		cases: own.length,
		passing: own.filter((c) => c.status === 'passed').map((c) => c.case),
		failing: Object.fromEntries(
			own.filter((c) => c.status === 'failed').map((c) => [c.case, c.failed]),
		),
		runs: totals.runs,
		passCounts: Object.fromEntries(
			own
				.filter((c) => c.status === 'passed' || c.status === 'failed')
				.map((c) => [c.case, c.passes]),
		),
		...(own.some((c) => c.harmful.length > 0) && {
			harmful: Object.fromEntries(
				own.filter((c) => c.harmful.length > 0).map((c) => [c.case, c.harmful]),
			),
		}),
		...(own.some((c) => c.status === 'outage') && {
			outages: own.filter((c) => c.status === 'outage').map((c) => c.case),
		}),
		cost: Number(totals.cost.toFixed(4)),
	};
}

/**
 * What changed for one model since its baseline: cases that passed there and fail now, and back.
 * With several runs a case fails now when it failed in most of them: one bad run of three is
 * variance, two are not.
 */
export function compareToBaseline(
	entry: BaselineEntry,
	slug: string,
	cells: readonly Cell[],
): { newlyFailing: string[]; newlyPassing: string[] } {
	const own = cells.filter((c) => c.model === slug);
	const passing = new Set(entry.passing);
	const failing = new Set(Object.keys(entry.failing));
	return {
		newlyFailing: own
			.filter(
				(c) =>
					c.status === 'failed' && passing.has(c.case) && (c.runs <= 1 || c.passes * 2 < c.runs),
			)
			.map((c) => c.case),
		newlyPassing: own
			.filter((c) => c.status === 'passed' && failing.has(c.case))
			.map((c) => c.case),
	};
}

/**
 * A new baseline entry that keeps, for each case an outage ended, the verdict the earlier entry
 * had for it: the run measured nothing there, so what was known stays known.
 */
export function withEarlierVerdicts(
	entry: BaselineEntry,
	earlier: BaselineEntry | undefined,
): BaselineEntry {
	if (!entry.outages?.length || !earlier) return entry;
	const passing = [...entry.passing];
	const failing = { ...entry.failing };
	const passCounts = { ...entry.passCounts };
	const harmful = { ...entry.harmful };
	for (const name of entry.outages) {
		if (earlier.passing.includes(name)) passing.push(name);
		const checks = earlier.failing[name];
		if (checks) failing[name] = checks;
		const count = earlier.passCounts?.[name];
		if (count !== undefined) passCounts[name] = count;
		const hurt = earlier.harmful?.[name];
		if (hurt) harmful[name] = hurt;
	}
	return {
		...entry,
		passing,
		failing,
		...(entry.passCounts && { passCounts }),
		...(Object.keys(harmful).length > 0 && { harmful }),
	};
}

export interface EvalOptions<C extends { name: string }> {
	/** Shown above the report, e.g. `Inbox extraction eval`. */
	title: string;
	/** The prompt version the cases ran against, kept in the baseline. */
	version?: string;
	/** A fingerprint of everything the model is asked, kept in the baseline and the recordings. */
	promptHash?: string;
	cases: readonly C[];
	/** Runs one case on its own kernel with the given model. */
	run(c: C, llm: LlmPort): Promise<CaseVerdict>;
	/** The eval's folder: `baseline.json` and `recorded/` live in it. */
	dir: string;
	env?: NodeJS.ProcessEnv;
	/** The models, instead of the ones the environment names. */
	models?: readonly EnvLlm[];
	log?(line: string): void;
	/** How a wait for the provider is spent (tests pass one that returns at once). */
	wait?(ms: number): Promise<unknown>;
}

/**
 * Runs the cases on every configured model and prints each case's lines, the table and the
 * change against the baseline. Returns the process exit code: 0 when every case passed on every
 * model, 1 when one did not, 2 when no model is configured.
 */
export async function runEval<C extends { name: string }>(
	options: EvalOptions<C>,
): Promise<number> {
	const env = options.env ?? process.env;
	const log = options.log ?? ((line: string) => console.log(line));
	const models = options.models ?? (await llmsFromEnv(env));
	if (models.length === 0) {
		log(
			'Set FAMOS_EVAL_API_KEY and FAMOS_EVAL_MODELS (or FAMOS_EVAL_MODEL, FAMOS_EVAL_PROVIDER, FAMOS_EVAL_BASE_URL).',
		);
		return 2;
	}
	const only = env.FAMOS_EVAL_CASE?.toLowerCase();
	const cases = options.cases.filter((c) => !only || c.name.toLowerCase().includes(only));
	const raw = Boolean(env.FAMOS_EVAL_RAW);
	const concurrency = env.FAMOS_EVAL_CONCURRENCY ? Number(env.FAMOS_EVAL_CONCURRENCY) : Infinity;
	const maxCost = env.FAMOS_EVAL_MAX_COST ? Number(env.FAMOS_EVAL_MAX_COST) : Infinity;
	const runs = env.FAMOS_EVAL_RUNS ? Number(env.FAMOS_EVAL_RUNS) : 1;
	if (!(concurrency >= 1) || !(maxCost > 0) || !Number.isInteger(runs) || runs < 1) {
		log(
			'FAMOS_EVAL_CONCURRENCY must be 1 or more, FAMOS_EVAL_MAX_COST more than 0 and FAMOS_EVAL_RUNS a whole number of 1 or more.',
		);
		return 2;
	}
	// Recordings, the report and the baseline are keyed by these names.
	for (const names of [options.cases.map((c) => slugOf(c.name)), models.map((m) => m.slug)]) {
		const twice = names.find((name, i) => names.indexOf(name) !== i);
		if (twice !== undefined) {
			log(`Two cases or models share the name "${twice}"; rename one.`);
			return 2;
		}
	}
	const record = env.FAMOS_EVAL_RECORD
		? env.FAMOS_EVAL_RECORD === '1'
			? join(options.dir, 'recorded')
			: env.FAMOS_EVAL_RECORD
		: null;
	const version = options.version ?? null;
	log(
		`${options.title}${version ? ` · ${version}` : ''} · ${cases.length} cases${runs > 1 ? ` × ${runs} runs` : ''} · ${models.map((m) => m.label).join(', ')}\n`,
	);

	// Run by run, case by case and model by model, so a cost cap leaves every model with the
	// same runs and cases.
	const work = Array.from({ length: runs }, (_, run) =>
		cases.flatMap((c) => models.map((model) => ({ c, model, run }))),
	).flat();
	let spent = 0;
	const lines = new Map<string, string[]>();
	/** Cases whose recording holds a run the provider did not break, by model and case. */
	const measured = new Set<string>();
	const started = Date.now();
	const done = await runPool(
		work,
		concurrency,
		async ({ c, model, run }) => {
			const observed = observe(model, raw, options.wait);
			const verdict = await options.run(c, observed.llm).catch(
				(error: unknown): CaseVerdict => ({
					ok: false,
					checks: 1,
					failed: ['the case ran to the end'],
					lines: [
						`✗ ${c.name}`,
						`    ✗ the case did not run: ${error instanceof Error ? error.message : String(error)}`,
					],
				}),
			);
			const cell = cellOf(c.name, model.slug, verdict, observed.calls);
			spent += cell.cost;
			const notes = observed.notes.map((note) => `      · ${note}`);
			// A run the provider broke shows no verdict of its checks: it counts neither way.
			const own =
				cell.status === 'outage'
					? [`! ${c.name} (the provider failed: counts neither way)`, ...notes]
					: [...verdict.lines, ...notes];
			// Several runs: a run that passed is one line, a run that did not is shown whole.
			const shown = runs > 1 && verdict.ok ? own.slice(0, 1) : own;
			lines.set(
				`${model.slug}\n${c.name}\n${run}`,
				runs > 1
					? shown.map((line, i) => (i === 0 ? `${line} (run ${run + 1}/${runs})` : line))
					: shown,
			);
			// The first run the provider did not break is the one kept (the first run when all were).
			const key = `${model.slug}\n${c.name}`;
			if (record && !measured.has(key)) {
				if (cell.status !== 'outage') measured.add(key);
				const folder = join(record, model.slug);
				mkdirSync(folder, { recursive: true });
				writeFileSync(
					join(folder, `${slugOf(c.name)}.json`),
					`${JSON.stringify({ case: c.name, model: model.label, version, ...(options.promptHash !== undefined && { promptHash: options.promptHash }), answers: observed.calls.map((call) => call.answer) }, null, '\t')}\n`,
				);
			}
			return cell;
		},
		() => spent < maxCost,
	);
	const cells = cases.flatMap((c) =>
		models.map((model) => {
			const own = done.filter(
				(cell): cell is Cell => cell !== null && cell.case === c.name && cell.model === model.slug,
			);
			return own.length > 0 ? mergeRuns(own) : cellOf(c.name, model.slug, null, []);
		}),
	);
	const totals = models.map((model) => totalsOf(model, cells));

	for (const model of models) {
		log(`── ${model.label}`);
		for (const c of cases)
			for (let run = 0; run < runs; run++)
				for (const line of lines.get(`${model.slug}\n${c.name}\n${run}`) ?? []) log(line);
		log('');
	}
	for (const line of formatTable(
		cases.map((c) => c.name),
		totals,
		cells,
	))
		log(line);
	const skipped = cells.filter((c) => c.status === 'skipped').length;
	// A run that was not made (the cost cap) leaves the numbers partial too.
	const partial = done.some((cell) => cell === null);
	log(
		`\n${usd(spent)} · ${((Date.now() - started) / 1000).toFixed(0)}s${partial ? ` · ${done.filter((cell) => cell === null).length} ${runs > 1 ? 'runs of cases' : 'cases'} skipped at the cost cap of ${usd(maxCost)}` : ''}`,
	);
	// The gate: a wrong value shown as certain, or a wrong thing acted on, must never happen.
	for (const t of totals) {
		log(
			`gate · ${t.label}: harmful ${t.harmful} (must be 0), missed ${t.missed}${t.medianPassRate === null ? '' : `, median pass rate ${Math.round(t.medianPassRate * 100)}% over ${t.runs} run${t.runs > 1 ? 's' : ''}`}`,
		);
		for (const cell of cells.filter((c) => c.model === t.slug)) {
			for (const label of cell.harmful) log(`  harmful · ${cell.case}: ${label}`);
			if (cell.runs > 1 && cell.passes > 0 && cell.passes < cell.runs)
				log(`  unsteady · ${cell.case}: passed ${cell.passes} of ${cell.runs}`);
		}
	}

	const baselinePath = join(options.dir, 'baseline.json');
	const baseline: Baseline = existsSync(baselinePath)
		? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline)
		: { models: {} };
	for (const model of models) {
		const entry = baseline.models[model.slug];
		if (!entry) continue;
		const { newlyFailing, newlyPassing } = compareToBaseline(entry, model.slug, cells);
		log(
			`vs baseline (${entry.date}) · ${model.label}: ${newlyFailing.length ? `newly failing: ${newlyFailing.join('; ')}` : 'nothing newly failing'}${newlyPassing.length ? ` · newly passing: ${newlyPassing.join('; ')}` : ''}`,
		);
	}

	const result: MatrixResult = {
		title: options.title,
		version,
		at: new Date(started).toISOString(),
		models: totals,
		cells,
	};
	if (env.FAMOS_EVAL_REPORT) {
		writeFileSync(env.FAMOS_EVAL_REPORT, `${JSON.stringify(result, null, '\t')}\n`);
		log(`Report written to ${env.FAMOS_EVAL_REPORT}`);
	}
	const outages = cells.filter((c) => c.status === 'outage');
	if (outages.length)
		log(
			`Outages (the provider failed, which says nothing about the model): ${outages.map((c) => `${c.case} · ${c.model}`).join('; ')}`,
		);
	if (env.FAMOS_EVAL_BASELINE) {
		if (only || skipped || partial) {
			log(
				'The baseline is kept only from a run of every case (no FAMOS_EVAL_CASE, no cost cap hit).',
			);
		} else {
			const date = result.at.slice(0, 10);
			for (const t of totals) {
				// A model the provider never answered was not measured at all: what was known stays.
				if (t.outages === t.cases) {
					log(`Baseline of ${t.label} kept: every case was an outage.`);
					continue;
				}
				baseline.models[t.slug] = withEarlierVerdicts(
					baselineEntry(t, cells, version, date, options.promptHash),
					baseline.models[t.slug],
				);
			}
			writeFileSync(baselinePath, `${JSON.stringify(baseline, null, '\t')}\n`);
			log(`Baseline written to ${baselinePath}`);
		}
	}
	return cells.every((c) => c.status === 'passed') ? 0 : 1;
}
