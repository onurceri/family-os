import { randomBytes } from 'node:crypto';
import {
	aiMigrations,
	aiTables,
	createAiSdkLlm,
	createAiSettings,
	createSecretBox,
	PROVIDER_KINDS,
	type ProviderKind,
	ProviderKindSchema,
	type UsageSummary,
} from '@famos/adapters/llm-aisdk';
import { silentLogger, uuidv7Ids } from '@famos/adapters/runtime';
import { openDatabase, runMigrations } from '@famos/db';
import type { LlmPort } from '@famos/sdk';

/** One model of an evaluation run. */
export interface EvalModelSpec {
	kind: ProviderKind;
	model: string;
	baseUrl?: string;
}

/** What the adapter recorded about one model call. */
export interface EnvCall {
	feature: string;
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	/** USD, when the provider reports it. */
	cost: number | null;
	latencyMs: number;
	/** Why the model stopped (`stop`, `length` …); null when it did not answer. */
	finishReason: string | null;
	errorCode: string | null;
	/** How a structured answer was asked for (`schema`, `json`, `text`); null for other calls. */
	outputMode: string | null;
}

export interface EnvLlm {
	llm: LlmPort;
	/** `provider / model`, for reports. */
	label: string;
	/** `provider-model` in lower case letters, digits and dashes: a file and key name. */
	slug: string;
	usage(): Promise<UsageSummary>;
	/** The calls recorded with this `jobId`, oldest first (a fallback retry is a second call). */
	calls(jobId: string): Promise<EnvCall[]>;
}

const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/** Lower case letters, digits and single dashes, for file names and keys. */
export const slugOf = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

/**
 * Reads `FAMOS_EVAL_MODELS`: a comma-separated list of `provider:model`, with `@<address>` at the
 * end for a provider on another address (`ollama:qwen3:8b@http://pi.local:11434/v1`). An entry
 * without a known provider before its first colon uses `fallbackKind`.
 */
export function parseEvalModels(value: string, fallbackKind: ProviderKind): EvalModelSpec[] {
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '')
		.map((entry) => {
			const colon = entry.indexOf(':');
			const head = colon < 0 ? '' : entry.slice(0, colon);
			const known = (PROVIDER_KINDS as readonly string[]).includes(head);
			const kind = known ? ProviderKindSchema.parse(head) : fallbackKind;
			const rest = known ? entry.slice(colon + 1) : entry;
			const at = /^(.+)@(https?:\/\/\S+)$/.exec(rest);
			const model = at ? (at[1] as string) : rest;
			if (model === '') throw new Error(`FAMOS_EVAL_MODELS: no model in "${entry}"`);
			return { kind, model, ...(at && { baseUrl: at[2] as string }) };
		});
}

/**
 * The models an evaluation runs against (never tests), configured from the environment:
 * `FAMOS_EVAL_MODELS` (see `parseEvalModels`), or one model from `FAMOS_EVAL_MODEL` (default
 * google/gemini-2.5-flash), `FAMOS_EVAL_PROVIDER` (default openrouter) and `FAMOS_EVAL_BASE_URL`.
 * `FAMOS_EVAL_API_KEY` is the key for every hosted model. Each model gets its own settings and
 * usage, so costs never mix. Empty when neither a key nor an address is set. Keys stay in memory.
 */
export async function llmsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<EnvLlm[]> {
	const fallbackKind = ProviderKindSchema.parse(env.FAMOS_EVAL_PROVIDER ?? 'openrouter');
	const specs = env.FAMOS_EVAL_MODELS
		? parseEvalModels(env.FAMOS_EVAL_MODELS, fallbackKind)
		: [
				{
					kind: fallbackKind,
					model: env.FAMOS_EVAL_MODEL ?? DEFAULT_MODEL,
					...(env.FAMOS_EVAL_BASE_URL && { baseUrl: env.FAMOS_EVAL_BASE_URL }),
				},
			];
	const apiKey = env.FAMOS_EVAL_API_KEY;
	const usable = specs.filter((spec) => apiKey || spec.baseUrl);
	// Free hosted models are served only by providers that keep data: FAMOS_EVAL_ZERO_RETENTION=0
	// lets the made-up cases reach them.
	const zeroRetention = env.FAMOS_EVAL_ZERO_RETENTION !== '0';
	return Promise.all(usable.map((spec) => envLlm(spec, apiKey, zeroRetention)));
}

async function envLlm(
	spec: EvalModelSpec,
	apiKey: string | undefined,
	zeroRetention: boolean,
): Promise<EnvLlm> {
	const { kind, model, baseUrl } = spec;
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'ai', migrations: aiMigrations }]);
	const clock = { now: () => Date.now() };
	const timeZone = async () => 'UTC';
	const settings = createAiSettings({
		db,
		box: createSecretBox(randomBytes(32).toString('hex')),
		clock,
		ids: uuidv7Ids,
		timeZone,
	});
	await settings.syncFromEnvironment({
		name: kind,
		kind,
		...(baseUrl && { baseUrl }),
		...(apiKey && { apiKey }),
		models: { fast: model, vision: model, smart: model },
	});
	if (!zeroRetention)
		await settings.setPrivacy({
			sendFiles: true,
			sendPeople: true,
			sendVoice: true,
			zeroRetention: false,
		});
	const llm = createAiSdkLlm({
		db,
		settings,
		clock,
		ids: uuidv7Ids,
		logger: silentLogger,
		timeZone,
		areaAccess: () => 'any',
	});
	return {
		llm,
		label: `${kind} / ${model}`,
		slug: slugOf(`${kind}-${model}`),
		usage: () => settings.usage(),
		async calls(jobId) {
			const rows = await aiTables(db)
				.selectFrom('ai_usage')
				.selectAll()
				.where('job_id', '=', jobId)
				.orderBy('at')
				.orderBy('id')
				.execute();
			return rows.map((r) => ({
				feature: r.feature,
				inputTokens: r.input_tokens,
				outputTokens: r.output_tokens,
				reasoningTokens: r.reasoning_tokens,
				cost: r.cost_micros === null ? null : r.cost_micros / 1_000_000,
				latencyMs: r.latency_ms,
				finishReason: r.finish_reason,
				errorCode: r.error_code,
				outputMode: r.output_mode,
			}));
		},
	};
}
