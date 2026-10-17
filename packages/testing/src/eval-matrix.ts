import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLlmError, type LlmPort } from '@famos/sdk';
import { type EnvCall, type EnvLlm, llmsFromEnv, slugOf } from './llm-from-env.ts';

/**
 * Runs evaluation cases against several real models and reports them side by side. Used by the
 * evals of the extensions (`pnpm --filter @famos/ext-inbox eval`), never by tests: they cost
 * money and depend on the provider. The environment:
 *
 * - `FAMOS_EVAL_MODELS` / `FAMOS_EVAL_MODEL` …: the models (see `llmsFromEnv`).
 * - `FAMOS_EVAL_CASE=substring`: only the cases whose name contains it.
 * - `FAMOS_EVAL_CONCURRENCY=n`: at most n cases at once over all models (default: all at once).
 * - `FAMOS_EVAL_MAX_COST=usd`: no case starts once the finished ones cost this much.
 * - `FAMOS_EVAL_REPORT=path`: writes the whole result as JSON.
 * - `FAMOS_EVAL_RECORD=1` (or a folder): saves each model's answers per case under
 *   `<eval folder>/recorded/<model>/<case>.json`. The cases are made up, never family data.
 * - `FAMOS_EVAL_BASELINE=1`: writes `<eval folder>/baseline.json` for the models of a full run.
 * - `FAMOS_EVAL_RAW=1`: shows every answer, and the text of an answer the app refused.
 * - `FAMOS_EVAL_VERBOSE=1`: passed to the case runner, which shows more of passed cases.
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
	failed: string[];
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
	/** Failing cases with the labels of their failed checks. */
	failing: Record<string, string[]>;
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

/**
 * The model of one case, recording every call: its answer, and the tokens, cost, time and
 * finish reason the adapter wrote down for it (found again by a `jobId` of its own).
 */
export function observe(env: EnvLlm, raw = false) {
	const calls: CallRecord[] = [];
	const notes: string[] = [];
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
	return {
		case: name,
		model,
		status:
			verdict === null
				? 'skipped'
				: verdict.ok
					? 'passed'
					: [...errors].some((e) => OUTAGES.has(e))
						? 'outage'
						: 'failed',
		checks: verdict?.checks ?? 0,
		failed: verdict?.failed ?? [],
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
		failedChecks: own.reduce((n, c) => n + c.failed.length, 0),
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
	return `${mark} ${tokens(cell.inputTokens)}/${tokens(cell.outputTokens)} ${usd(cell.cost)} ${seconds(cell.latencyMs)} ${stop}${modes}`;
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
		['checks', ...models.map((m) => `${m.checks - m.failedChecks}/${m.checks}`)],
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
		...(own.some((c) => c.status === 'outage') && {
			outages: own.filter((c) => c.status === 'outage').map((c) => c.case),
		}),
		cost: Number(totals.cost.toFixed(4)),
	};
}

/** What changed for one model since its baseline: cases that passed there and fail now, and back. */
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
			.filter((c) => c.status === 'failed' && passing.has(c.case))
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
	for (const name of entry.outages) {
		if (earlier.passing.includes(name)) passing.push(name);
		const checks = earlier.failing[name];
		if (checks) failing[name] = checks;
	}
	return { ...entry, passing, failing };
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
	if (!(concurrency >= 1) || !(maxCost > 0)) {
		log('FAMOS_EVAL_CONCURRENCY must be 1 or more and FAMOS_EVAL_MAX_COST more than 0.');
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
		`${options.title}${version ? ` · ${version}` : ''} · ${cases.length} cases · ${models.map((m) => m.label).join(', ')}\n`,
	);

	// Model by model within each case, so a cost cap leaves every model with the same cases.
	const work = cases.flatMap((c) => models.map((model) => ({ c, model })));
	let spent = 0;
	const lines = new Map<string, string[]>();
	const started = Date.now();
	const done = await runPool(
		work,
		concurrency,
		async ({ c, model }) => {
			const observed = observe(model, raw);
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
			lines.set(`${model.slug}\n${c.name}`, [
				...verdict.lines,
				...observed.notes.map((note) => `      · ${note}`),
			]);
			if (record) {
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
	const cells = done.map(
		(cell, i) => cell ?? cellOf(work[i]?.c.name ?? '', work[i]?.model.slug ?? '', null, []),
	);
	const totals = models.map((model) => totalsOf(model, cells));

	for (const model of models) {
		log(`── ${model.label}`);
		for (const c of cases)
			for (const line of lines.get(`${model.slug}\n${c.name}`) ?? []) log(line);
		log('');
	}
	for (const line of formatTable(
		cases.map((c) => c.name),
		totals,
		cells,
	))
		log(line);
	const skipped = cells.filter((c) => c.status === 'skipped').length;
	log(
		`\n${usd(spent)} · ${((Date.now() - started) / 1000).toFixed(0)}s${skipped ? ` · ${skipped} cases skipped at the cost cap of ${usd(maxCost)}` : ''}`,
	);

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
		if (only || skipped) {
			log(
				'The baseline is kept only from a run of every case (no FAMOS_EVAL_CASE, no cost cap hit).',
			);
		} else {
			const date = result.at.slice(0, 10);
			for (const t of totals)
				baseline.models[t.slug] = withEarlierVerdicts(
					baselineEntry(t, cells, version, date, options.promptHash),
					baseline.models[t.slug],
				);
			writeFileSync(baselinePath, `${JSON.stringify(baseline, null, '\t')}\n`);
			log(`Baseline written to ${baselinePath}`);
		}
	}
	return cells.every((c) => c.status === 'passed') ? 0 : 1;
}
