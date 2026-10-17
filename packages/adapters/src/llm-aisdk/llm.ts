import { setTimeout as sleep } from 'node:timers/promises';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
	type AiAreaAccess,
	type Clock,
	type DbExecutor,
	type IdGenerator,
	isLlmError,
	type LlmChatRequest,
	type LlmChatResult,
	type LlmEmbedRequest,
	type LlmEmbedResult,
	LlmError,
	type LlmObjectRequest,
	type LlmObjectResult,
	type LlmPolicy,
	type LlmPort,
	type LlmReasoning,
	type LlmTranscribeRequest,
	type LlmTranscribeResult,
	type Logger,
	type ModelRole,
	type OutputMode,
} from '@famos/sdk';
import {
	APICallError,
	type EmbeddingModel,
	embedMany,
	generateText,
	isStepCount,
	jsonSchema,
	type LanguageModel,
	type ModelMessage,
	NoObjectGeneratedError,
	Output,
	RetryError,
	streamText,
	tool,
} from 'ai';
import { sql } from 'kysely';
import {
	extractJson,
	NEXT_MODE,
	outputModeFor,
	reasoningFor,
	schemaInstruction,
} from './output.ts';
import { type AiSettingsService, monthBounds, type ResolvedProvider } from './settings.ts';
import { aiTables } from './tables.ts';

/** Builds the model client for a provider; tests replace it with a mock model. */
export type ModelFactory = (
	provider: ResolvedProvider,
	model: string,
	options?: ModelOptions,
) => LanguageModel;

export interface ModelOptions {
	/** Only for providers that take it in the request body rather than as `reasoning_effort`. */
	reasoning?: LlmReasoning;
}

/** The provider-neutral level as the OpenAI-compatible `reasoning_effort` value. */
const effortOf = (level: LlmReasoning) => (level === 'off' ? ('none' as const) : level);

/**
 * Whether the reasoning level goes to the provider as a top-level option (the SDK sends it
 * as `reasoning_effort`). OpenRouter takes it in a `reasoning` object instead, added in
 * `transformRequestBody`.
 */
const reasoningInBody = (provider: ResolvedProvider) => provider.kind === 'openrouter';

/**
 * One OpenAI-compatible client covers every provider kind (structured output,
 * images and OpenRouter's reported cost all work through it). OpenRouter is asked to include the
 * call's cost in the usage block.
 */
export const openAiCompatibleModel: ModelFactory = (provider, model, options) =>
	createOpenAICompatible({
		name: provider.kind,
		baseURL: provider.baseUrl,
		...(provider.apiKey && { apiKey: provider.apiKey }),
		includeUsage: true,
		supportsStructuredOutputs: true,
		...(provider.kind === 'openrouter' && {
			transformRequestBody: (body: Record<string, unknown>) => ({
				...body,
				usage: { include: true },
				...(options?.reasoning && { reasoning: { effort: effortOf(options.reasoning) } }),
				// Only endpoints that keep no prompts and do not train on them (verified 2026-10-06).
				...(provider.zeroRetention && { provider: { zdr: true, data_collection: 'deny' } }),
			}),
		}),
		metadataExtractor: {
			extractMetadata: async ({ parsedBody }) => {
				const cost = (parsedBody as { usage?: { cost?: unknown } } | null)?.usage?.cost;
				return typeof cost === 'number' ? { famos: { cost } } : undefined;
			},
			// OpenRouter reports the cost in the last chunk's usage block.
			createStreamExtractor: () => {
				let cost: number | undefined;
				return {
					processChunk(chunk) {
						const reported = (chunk as { usage?: { cost?: unknown } } | null)?.usage?.cost;
						if (typeof reported === 'number') cost = reported;
					},
					buildMetadata: () => (cost === undefined ? undefined : { famos: { cost } }),
				};
			},
		},
	}).chatModel(model);

/** Builds the embedding client for a provider; tests replace it with a mock model. */
export type EmbeddingFactory = (provider: ResolvedProvider, model: string) => EmbeddingModel;

/** Embeddings go through the same OpenAI-compatible client (`/embeddings`). */
export const openAiCompatibleEmbedder: EmbeddingFactory = (provider, model) =>
	createOpenAICompatible({
		name: provider.kind,
		baseURL: provider.baseUrl,
		...(provider.apiKey && { apiKey: provider.apiKey }),
	}).embeddingModel(model);

export interface AiSdkLlmDeps {
	db: DbExecutor;
	settings: AiSettingsService;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	timeZone(): Promise<string>;
	/**
	 * How far the AI may use an area (an extension id); core's cached setting. Calls
	 * whose `areas` include an area that is off, or local-only with a non-local provider, fail.
	 */
	areaAccess(extensionId: string): AiAreaAccess;
	model?: ModelFactory;
	embedder?: EmbeddingFactory;
	/** For speech-to-text calls; tests point it at a stand-in. */
	fetch?: typeof fetch;
}

/** Maps an HTTP status of a speech-to-text call to the error codes of the port. */
function statusToLlmError(status: number, body: string): LlmError {
	if (status === 401 || status === 403)
		return new LlmError('auth', 'The provider refused the API key');
	if (status === 402) return new LlmError('limit_reached', 'The provider account is out of credit');
	if (status === 404)
		return new LlmError(
			'not_configured',
			'The provider has no speech-to-text endpoint or model for this name',
		);
	if (status === 400 || status === 413 || status === 415 || status === 422) {
		return new LlmError(
			'rejected',
			`The provider rejected the audio (HTTP ${status}) ${body.slice(0, 300)}`.trim(),
		);
	}
	return new LlmError('unavailable', `The provider is unavailable (HTTP ${status})`);
}

/** The longest a call waits for a rate limit to pass before it asks once more. */
const RATE_WAIT_MAX_MS = 10_000;

/**
 * The wait a `retry-after` header asks for (seconds, or an HTTP date), in milliseconds; undefined
 * when there is none or it cannot be read.
 */
export function retryAfterOf(
	headers: Record<string, string> | undefined,
	now: number,
): number | undefined {
	const value = Object.entries(headers ?? {})
		.find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
		?.trim();
	if (!value) return undefined;
	if (/^\d+(\.\d+)?$/u.test(value)) return Math.round(Number(value) * 1000);
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function toLlmError(error: unknown): LlmError {
	if (isLlmError(error)) return error;
	// The AI SDK's own retry gave up: what failed is its last error (a 429 keeps its wait).
	if (RetryError.isInstance(error) && error.lastError !== undefined)
		return toLlmError(error.lastError);
	if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
		return new LlmError('timeout', 'The model did not answer in time', { cause: error });
	}
	if (NoObjectGeneratedError.isInstance(error)) {
		const usage = {
			inputTokens: error.usage?.inputTokens ?? null,
			outputTokens: error.usage?.outputTokens ?? null,
			reasoningTokens: error.usage?.outputTokenDetails?.reasoningTokens || null,
			finishReason: error.finishReason ?? null,
		};
		// The answer was cut off by the output cap: a retry would be cut off the same way.
		if (error.finishReason === 'length') {
			return new LlmError('output_too_long', "The model's answer was longer than allowed", {
				cause: error,
				usage,
			});
		}
		return new LlmError('invalid_output', 'The model did not return the expected structure', {
			cause: error,
			usage,
		});
	}
	if (APICallError.isInstance(error)) {
		const status = error.statusCode ?? 0;
		if (status === 401 || status === 403)
			return new LlmError('auth', 'The provider refused the API key', { cause: error });
		if (status === 402)
			return new LlmError('limit_reached', 'The provider account is out of credit', {
				cause: error,
			});
		if (
			status === 404 &&
			/data policy|zdr|retention/i.test(`${error.message} ${error.responseBody}`)
		) {
			return new LlmError(
				'data_policy',
				'No provider of this model keeps zero data; choose another model or relax the privacy setting',
				{ cause: error },
			);
		}
		if (status === 404) {
			return new LlmError('not_configured', `The model was not found: ${error.message}`, {
				cause: error,
			});
		}
		if (status === 400 || status === 422) {
			// Gateways (OpenRouter) put the upstream reason in the body, not in the message.
			const body = error.responseBody?.slice(0, 400) ?? '';
			return new LlmError(
				'rejected',
				`The provider rejected the request: ${error.message} ${body}`.trim(),
				{
					cause: error,
				},
			);
		}
		// Too many calls for now (free models have tight limits): worth asking again later, and
		// it says nothing about the model.
		if (status === 429) {
			const retryAfterMs = retryAfterOf(error.responseHeaders, Date.now());
			return new LlmError('unavailable', 'The provider is rate limited (HTTP 429)', {
				cause: error,
				...(retryAfterMs !== undefined && { retryAfterMs }),
			});
		}
		return new LlmError(
			'unavailable',
			`The provider is unavailable (HTTP ${status || 'network'})`,
			{ cause: error },
		);
	}
	return new LlmError('unavailable', error instanceof Error ? error.message : String(error), {
		cause: error,
	});
}

/**
 * The mode to ask in after a failed one, or null to give up. A refused request steps down every
 * time (a server that rejects a JSON Schema may still take a JSON object, and one that rejects
 * both still answers in text). An unusable answer steps down only from `schema`: constrained
 * decoding is what makes some models loop or leave fields out, and without it a retry in another
 * mode would only repeat the same answer.
 */
function fallbackFrom(mode: OutputMode, failure: LlmError): OutputMode | null {
	if (failure.code === 'rejected') return NEXT_MODE[mode];
	if (
		mode === 'schema' &&
		(failure.code === 'invalid_output' || failure.code === 'output_too_long')
	)
		return NEXT_MODE[mode];
	return null;
}

/** Chat messages as the AI SDK wants them. A tool result is preceded by the call it answers. */
function toModelMessages(messages: LlmChatRequest['messages']): ModelMessage[] {
	return messages.flatMap((m, i): ModelMessage[] => {
		if (m.role !== 'tool') return [{ role: m.role, content: m.content }];
		const toolCallId = m.toolCallId ?? `call_${i}`;
		const toolName = m.toolName ?? 'tool';
		return [
			{ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: {} }] },
			{
				role: 'tool',
				content: [
					{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: m.content } },
				],
			},
		];
	});
}

/**
 * LlmPort on the AI SDK: resolves the role to a provider and model, enforces the
 * monthly limits, calls the model with the request's timeout and records every call in
 * `ai_usage` (also failures). Prompts and outputs are never logged.
 */
export function createAiSdkLlm(deps: AiSdkLlmDeps): LlmPort {
	const factory = deps.model ?? openAiCompatibleModel;
	const embedder = deps.embedder ?? openAiCompatibleEmbedder;
	const logger = deps.logger.child({ component: 'llm' });

	async function checkLimits() {
		const limits = await deps.settings.limits();
		if (limits.monthlyCallLimit === null && limits.monthlyCostLimit === null) return;
		const { start, end } = monthBounds(await deps.timeZone(), deps.clock.now());
		const used = await aiTables(deps.db)
			.selectFrom('ai_usage')
			.select([
				(eb) => eb.fn.countAll<number>().as('calls'),
				sql<number>`coalesce(sum(cost_micros), 0)`.as('costMicros'),
			])
			.where('at', '>=', start)
			.where('at', '<', end)
			.executeTakeFirstOrThrow();
		if (limits.monthlyCallLimit !== null && Number(used.calls) >= limits.monthlyCallLimit) {
			throw new LlmError('limit_reached', 'The monthly limit of model calls is reached');
		}
		if (
			limits.monthlyCostLimit !== null &&
			Number(used.costMicros) / 1_000_000 >= limits.monthlyCostLimit
		) {
			throw new LlmError('limit_reached', 'The monthly AI budget is spent');
		}
	}

	/** The area rules for one call; the first area that is closed decides. */
	async function checkAreas(areas: readonly string[], baseUrl: string) {
		let local: boolean | undefined;
		for (const area of new Set(areas)) {
			const access = deps.areaAccess(area);
			if (access === 'off') throw new LlmError('disabled', `AI access to ${area} is off`);
			if (access === 'local') {
				local ??= await deps.settings.isLocal(baseUrl);
				if (!local)
					throw new LlmError(
						'local_required',
						`${area} may only use a local model, and the provider for this kind of work is not local`,
					);
			}
		}
	}

	/** Role → provider and model, or the error that tells the family what to set up. */
	async function target(roleName: ModelRole) {
		const privacy = await deps.settings.privacy();
		const role = (await deps.settings.roles())[roleName];
		if (!role) throw new LlmError('not_configured', `No model is set for the "${roleName}" role`);
		const resolved = await deps.settings.resolve(role.providerId).catch(() => null);
		const provider = resolved && { ...resolved, zeroRetention: privacy.zeroRetention };
		if (!provider)
			throw new LlmError(
				'not_configured',
				`The provider of the "${roleName}" role no longer exists`,
			);
		if (provider.kind === 'openrouter' && !provider.apiKey) {
			throw new LlmError(
				'auth',
				`${provider.name} has no readable API key; enter it again in AI settings`,
			);
		}
		return { privacy, role, provider };
	}

	/** Writes one `ai_usage` row for a call (also a failed or refused one). */
	function recorder(
		request: {
			role: ModelRole;
			feature: string;
			areas: readonly string[];
			memberId?: string | null | undefined;
			jobId?: string | null | undefined;
		},
		providerId: string,
		label: string,
		started: number,
	) {
		return async (fields: {
			input?: number | null;
			output?: number | null;
			reasoning?: number | null;
			finishReason?: string | null;
			cost?: number | null;
			errorCode?: string | null;
			outputMode?: OutputMode | null;
		}) => {
			await aiTables(deps.db)
				.insertInto('ai_usage')
				.values({
					id: deps.ids.next('ai_call'),
					at: started,
					role: request.role,
					provider_id: providerId,
					model: label,
					feature: request.feature,
					member_id: request.memberId ?? null,
					job_id: request.jobId ?? null,
					input_tokens: fields.input ?? null,
					output_tokens: fields.output ?? null,
					reasoning_tokens: fields.reasoning ?? null,
					finish_reason: fields.finishReason ?? null,
					cost_micros: fields.cost == null ? null : Math.round(fields.cost * 1_000_000),
					latency_ms: Math.max(0, deps.clock.now() - started),
					error_code: fields.errorCode ?? null,
					areas: JSON.stringify([...new Set(request.areas)]),
					output_mode: fields.outputMode ?? null,
				})
				.execute();
		};
	}

	/** What a failed call used, as the fields `record` takes. */
	const failureFields = (failure: LlmError) => ({
		errorCode: failure.code,
		input: failure.usage?.inputTokens ?? null,
		output: failure.usage?.outputTokens ?? null,
		reasoning: failure.usage?.reasoningTokens ?? null,
		finishReason: failure.usage?.finishReason ?? null,
		cost: failure.usage?.cost ?? null,
	});

	async function policy(feature: string, roleName: ModelRole): Promise<LlmPolicy> {
		const [{ sendFiles, sendPeople, sendVoice }, { enabled, off }, roles] = await Promise.all([
			deps.settings.privacy(),
			deps.settings.switches(),
			deps.settings.roles(),
		]);
		const role = roles[roleName];
		const resolved = role ? await deps.settings.resolve(role.providerId).catch(() => null) : null;
		return {
			enabled: enabled && !off.includes(feature),
			sendFiles,
			sendPeople,
			sendVoice,
			local: resolved ? await deps.settings.isLocal(resolved.baseUrl) : false,
			model: role && resolved ? `${resolved.id}:${role.model}` : null,
		};
	}

	return {
		policy,

		async generateObject<T>(request: LlmObjectRequest<T>): Promise<LlmObjectResult<T>> {
			if (!(await policy(request.feature, request.role)).enabled)
				throw new LlmError('disabled', `AI is turned off for ${request.feature}`);
			const { privacy, role, provider } = await target(request.role);

			const label = `${provider.name} / ${role.model}`;
			const started = deps.clock.now();
			const record = recorder(request, provider.id, label, started);

			// A refused call is recorded like any failure (the error code only), and never retried
			// with another provider.
			try {
				await checkAreas(request.areas, provider.baseUrl);
			} catch (error) {
				const failure = toLlmError(error);
				await record({ errorCode: failure.code });
				throw failure;
			}
			await checkLimits();

			// The schema as the provider would get it, built once: in `json` and `text` modes the
			// model reads it in the system prompt instead.
			const format = await Output.object({
				schema: request.jsonSchema ? jsonSchema<T>(request.jsonSchema) : request.schema,
			}).responseFormat;
			const schemaShown = format?.type === 'json' ? format.schema : undefined;

			/** What the provider reported the call cost; local models cost nothing. */
			const costOf = (metadata: Record<string, unknown> | undefined) => {
				const reported = (metadata?.famos as { cost?: number } | undefined)?.cost;
				return typeof reported === 'number' ? reported : provider.kind === 'ollama' ? 0 : null;
			};

			const attempt = async (mode: OutputMode, reasoning: LlmReasoning | undefined) => {
				const system =
					mode === 'schema' || !schemaShown
						? request.system
						: [request.system, schemaInstruction(schemaShown)].filter(Boolean).join('\n\n');
				const result = await generateText({
					model: factory(provider, role.model, reasoning ? { reasoning } : undefined),
					// The answer is always taken as text and validated here, so a mode changes only what
					// the provider is asked for.
					output: {
						...Output.text(),
						responseFormat: Promise.resolve(
							mode === 'schema' ? format : mode === 'json' ? { type: 'json' as const } : undefined,
						),
					},
					...(system && { system }),
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: request.prompt },
								// Callers honour `policy()`; files are dropped here too when not allowed.
								...(privacy.sendFiles ? (request.files ?? []) : []).map((f) => ({
									type: 'file' as const,
									data: f.data,
									mediaType: f.mediaType,
								})),
							],
						},
					],
					// Strict JSON-schema mode (OpenAI) rejects optional fields, which most action inputs
					// have. The output is validated against the Zod schema here instead.
					providerOptions: { openaiCompatible: { strictJsonSchema: false } },
					...(request.maxOutputTokens !== undefined && {
						maxOutputTokens: request.maxOutputTokens,
					}),
					...(request.temperature !== undefined && { temperature: request.temperature }),
					...(reasoning && !reasoningInBody(provider) && { reasoning: effortOf(reasoning) }),
					maxRetries: 1,
					abortSignal: AbortSignal.timeout(request.timeoutMs),
				});
				// A refused answer still cost what it cost; its text stays on the error (never logged)
				// for an evaluation to show.
				const usage = {
					inputTokens: result.usage.inputTokens ?? null,
					outputTokens: result.usage.outputTokens ?? null,
					reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens || null,
					finishReason: result.finishReason ?? null,
					cost: costOf(result.providerMetadata),
				};
				const cause = { text: result.text };
				// Nothing written and no ordinary stop (finish "other", or no tokens at all): the
				// provider failed on its side, which says nothing about the model or the request.
				if (
					result.text.trim() === '' &&
					(result.finishReason === 'other' || result.usage.outputTokens === 0)
				)
					throw new LlmError('unavailable', 'The provider returned an empty answer', {
						cause,
						usage,
					});
				const found = extractJson(result.text);
				if (!found) {
					// The answer was cut off by the output cap: a retry would be cut off the same way.
					if (result.finishReason === 'length')
						throw new LlmError('output_too_long', "The model's answer was longer than allowed", {
							cause,
							usage,
						});
					throw new LlmError('invalid_output', 'The model did not answer with JSON', {
						cause,
						usage,
					});
				}
				const parsed = request.schema.safeParse(found.value);
				if (!parsed.success) {
					// Paths only: the values come from family content.
					const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
					throw new LlmError(
						'invalid_output',
						`The model's answer did not match the expected structure at ${paths.slice(0, 5).join(', ')}`,
						{ cause, usage },
					);
				}
				return { result, output: parsed.data };
			};

			const reasoning = request.reasoning ?? reasoningFor(provider.kind, role.model);
			/** One mode, asked again without the reasoning setting when a model refuses it. */
			const inMode = async (mode: OutputMode) => {
				try {
					return await attempt(mode, reasoning);
				} catch (error) {
					// Models without a thinking mode can refuse the setting; asking again without it
					// still gets the answer.
					if (reasoning && toLlmError(error).code === 'rejected') {
						logger.warn(
							{ feature: request.feature, model: label },
							'provider rejected the reasoning setting; asking again without it',
						);
						return attempt(mode, undefined);
					}
					throw error;
				}
			};

			let mode = request.output ?? outputModeFor(provider.kind, role.model);
			// A provider that fails on its side once (an empty answer, a broken connection) is
			// asked once more in the same mode before the failure counts.
			let again = true;
			for (;;) {
				try {
					const { result, output } = await inMode(mode);
					const usage = {
						inputTokens: result.usage.inputTokens ?? null,
						outputTokens: result.usage.outputTokens ?? null,
						reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens || null,
						cost: costOf(result.providerMetadata),
					};
					await record({
						input: usage.inputTokens,
						output: usage.outputTokens,
						reasoning: usage.reasoningTokens,
						finishReason: result.finishReason ?? null,
						cost: usage.cost,
						outputMode: mode,
					});
					return { output, model: label, usage, outputMode: mode };
				} catch (error) {
					const failure = toLlmError(error);
					await record({ ...failureFields(failure), outputMode: mode });
					// A rate limit that asks for a long wait is left to the job's backoff.
					if (
						failure.code === 'unavailable' &&
						again &&
						(failure.retryAfterMs ?? 0) <= RATE_WAIT_MAX_MS
					) {
						again = false;
						if (failure.retryAfterMs) await sleep(failure.retryAfterMs);
						logger.warn(
							{
								feature: request.feature,
								role: request.role,
								model: label,
								code: failure.code,
								outputMode: mode,
								reason: failure.message.slice(0, 300),
								...failure.usage,
							},
							'the provider failed; asking once more',
						);
						continue;
					}
					const next = request.output ? null : fallbackFrom(mode, failure);
					logger.warn(
						// The provider's error text describes the request, not family content.
						{
							feature: request.feature,
							role: request.role,
							model: label,
							code: failure.code,
							outputMode: mode,
							reason: failure.message.slice(0, 300),
							...failure.usage,
							...(next && { next }),
						},
						next ? 'model call failed; asking again in another output mode' : 'model call failed',
					);
					if (!next) throw failure;
					mode = next;
				}
			}
		},
		async chat(request: LlmChatRequest): Promise<LlmChatResult> {
			if (!(await policy(request.feature, request.role)).enabled)
				throw new LlmError('disabled', `AI is turned off for ${request.feature}`);
			const { role, provider } = await target(request.role);

			const label = `${provider.name} / ${role.model}`;
			const started = deps.clock.now();
			const record = recorder(request, provider.id, label, started);
			try {
				await checkAreas(request.areas, provider.baseUrl);
			} catch (error) {
				const failure = toLlmError(error);
				await record({ errorCode: failure.code });
				throw failure;
			}
			await checkLimits();

			const calls: { name: string; ok: boolean }[] = [];
			const tools = Object.fromEntries(
				request.tools.map((t) => [
					t.name,
					tool({
						description: t.description,
						inputSchema: jsonSchema(t.inputSchema),
						async execute(input: unknown) {
							request.onToolCall?.(t.name, input);
							try {
								const result = await t.execute(input);
								calls.push({ name: t.name, ok: true });
								request.onToolResult?.(t.name, true);
								return typeof result === 'string' ? result : JSON.stringify(result ?? null);
							} catch (error) {
								// The model sees that the call failed and why, and can recover or say so.
								calls.push({ name: t.name, ok: false });
								request.onToolResult?.(t.name, false);
								return `Error: ${error instanceof Error ? error.message : 'the tool failed'}`;
							}
						},
					}),
				]),
			);

			try {
				const result = streamText({
					model: factory(provider, role.model),
					...(request.system && { system: request.system }),
					messages: toModelMessages(request.messages),
					tools,
					...(request.temperature !== undefined && { temperature: request.temperature }),
					stopWhen: isStepCount(Math.max(1, request.maxSteps)),
					// Once the host closes the tools, the next step can only be the answer.
					prepareStep: () => (request.toolsClosed?.() ? { toolChoice: 'none' as const } : {}),
					providerOptions: { openaiCompatible: { strictJsonSchema: false } },
					maxRetries: 1,
					abortSignal: AbortSignal.timeout(request.timeoutMs),
				});
				let text = '';
				let stepStart = true;
				let input: number | null = null;
				let output: number | null = null;
				let cost: number | null = null;
				for await (const part of result.fullStream) {
					if (part.type === 'error') throw part.error;
					// The time limit of the whole loop ran out.
					if (part.type === 'abort')
						throw new DOMException('The model did not answer in time', 'TimeoutError');
					// A call the loop could not run: a tool that was not offered, or input that does not
					// fit its schema. The model is told and may recover; the log says which (no input).
					if (part.type === 'tool-error') {
						calls.push({ name: part.toolName, ok: false });
						logger.warn(
							{
								feature: request.feature,
								model: label,
								tool: part.toolName,
								offered: part.toolName in tools,
								reason: String((part.error as Error)?.message ?? part.error).slice(0, 200),
							},
							'tool call failed',
						);
					}
					if (part.type === 'start-step') stepStart = text.length > 0;
					if (part.type === 'text-delta' && part.text) {
						// Text of a later step (after tool calls) continues the answer in a new paragraph.
						const delta = stepStart ? `\n\n${part.text}` : part.text;
						stepStart = false;
						text += delta;
						request.onText?.(delta);
					}
					if (part.type === 'finish-step') {
						if (part.usage.inputTokens != null) input = (input ?? 0) + part.usage.inputTokens;
						if (part.usage.outputTokens != null) output = (output ?? 0) + part.usage.outputTokens;
						const reported = (part.providerMetadata?.famos as { cost?: number } | undefined)?.cost;
						if (typeof reported === 'number') cost = (cost ?? 0) + reported;
					}
				}
				const usage = {
					inputTokens: input,
					outputTokens: output,
					cost: cost ?? (provider.kind === 'ollama' ? 0 : null),
				};
				await record({ input, output, cost: usage.cost });
				return { text: text.trim(), toolCalls: calls, model: label, usage };
			} catch (error) {
				const failure = toLlmError(error);
				await record({ errorCode: failure.code });
				logger.warn(
					{
						feature: request.feature,
						role: request.role,
						model: label,
						code: failure.code,
						reason: failure.message.slice(0, 300),
					},
					'model call failed',
				);
				throw failure;
			}
		},
		async embed(request: LlmEmbedRequest): Promise<LlmEmbedResult> {
			if (!(await policy(request.feature, 'embed')).enabled)
				throw new LlmError('disabled', `AI is turned off for ${request.feature}`);
			const { role, provider } = await target('embed');

			const label = `${provider.name} / ${role.model}`;
			const started = deps.clock.now();
			const record = recorder(
				{
					role: 'embed',
					feature: request.feature,
					areas: [request.area],
					memberId: request.memberId,
					jobId: request.jobId,
				},
				provider.id,
				label,
				started,
			);
			try {
				await checkAreas([request.area], provider.baseUrl);
			} catch (error) {
				const failure = toLlmError(error);
				await record({ errorCode: failure.code });
				throw failure;
			}
			await checkLimits();

			try {
				const result = await embedMany({
					model: embedder(provider, role.model),
					values: [...request.texts],
					maxRetries: 1,
					abortSignal: AbortSignal.timeout(request.timeoutMs),
				});
				const vectors = result.embeddings.map((e) => Float32Array.from(e));
				const dimensions = vectors[0]?.length ?? 0;
				if (
					vectors.length !== request.texts.length ||
					dimensions === 0 ||
					vectors.some((v) => v.length !== dimensions)
				) {
					throw new LlmError('invalid_output', 'The model did not return one vector per text');
				}
				const tokens = Number.isFinite(result.usage.tokens) ? result.usage.tokens : null;
				await record({ input: tokens, cost: provider.kind === 'ollama' ? 0 : null });
				return { vectors, model: `${provider.id}:${role.model}`, dimensions };
			} catch (error) {
				// The SDK throws a plain error when the provider returns fewer vectors than texts.
				const failure =
					error instanceof Error && /embeddings, but received/.test(error.message)
						? new LlmError('invalid_output', 'The model did not return one vector per text', {
								cause: error,
							})
						: toLlmError(error);
				await record({ errorCode: failure.code });
				logger.warn(
					{
						feature: request.feature,
						role: 'embed',
						model: label,
						code: failure.code,
						reason: failure.message.slice(0, 300),
					},
					'embedding failed',
				);
				throw failure;
			}
		},
		async transcribe(request: LlmTranscribeRequest): Promise<LlmTranscribeResult> {
			const allowed = await policy(request.feature, 'transcribe');
			if (!allowed.enabled)
				throw new LlmError('disabled', `AI is turned off for ${request.feature}`);
			if (!allowed.sendVoice) throw new LlmError('disabled', 'Voice notes are not sent to the AI');
			const { role, provider } = await target('transcribe');
			if (provider.kind === 'ollama') {
				throw new LlmError(
					'not_configured',
					'Ollama has no speech-to-text endpoint; choose another provider for this role',
				);
			}

			const label = `${provider.name} / ${role.model}`;
			const started = deps.clock.now();
			const record = async (fields: { cost?: number | null; errorCode?: string | null }) => {
				await aiTables(deps.db)
					.insertInto('ai_usage')
					.values({
						id: deps.ids.next('ai_call'),
						at: started,
						role: 'transcribe',
						provider_id: provider.id,
						model: label,
						feature: request.feature,
						member_id: request.memberId ?? null,
						job_id: request.jobId ?? null,
						input_tokens: null,
						output_tokens: null,
						cost_micros: fields.cost == null ? null : Math.round(fields.cost * 1_000_000),
						latency_ms: Math.max(0, deps.clock.now() - started),
						error_code: fields.errorCode ?? null,
						areas: JSON.stringify([...new Set(request.areas)]),
					})
					.execute();
			};

			try {
				await checkAreas(request.areas, provider.baseUrl);
			} catch (error) {
				const failure = toLlmError(error);
				await record({ errorCode: failure.code });
				throw failure;
			}
			await checkLimits();

			try {
				const form = new FormData();
				form.append(
					'file',
					new Blob([request.audio as Uint8Array<ArrayBuffer>], { type: request.mediaType }),
					request.filename,
				);
				form.append('model', role.model);
				form.append('response_format', 'json');
				if (request.language) form.append('language', request.language);
				const response = await (deps.fetch ?? fetch)(`${provider.baseUrl}/audio/transcriptions`, {
					method: 'POST',
					headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
					body: form,
					signal: AbortSignal.timeout(request.timeoutMs),
				});
				if (!response.ok) throw statusToLlmError(response.status, await response.text());
				const body = (await response.json().catch(() => null)) as {
					text?: unknown;
					usage?: { cost?: unknown };
				} | null;
				if (typeof body?.text !== 'string') {
					throw new LlmError('invalid_output', 'The provider did not return a transcript');
				}
				const reported = body.usage?.cost;
				const cost = typeof reported === 'number' ? reported : null;
				await record({ cost });
				return {
					text: body.text.trim(),
					model: label,
					usage: { inputTokens: null, outputTokens: null, cost },
				};
			} catch (error) {
				const failure = toLlmError(error);
				await record({ errorCode: failure.code });
				logger.warn(
					{
						feature: request.feature,
						role: 'transcribe',
						model: label,
						code: failure.code,
						reason: failure.message.slice(0, 300),
					},
					'transcription failed',
				);
				throw failure;
			}
		},
	};
}
