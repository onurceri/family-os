import { setTimeout as sleep } from 'node:timers/promises';
import {
	LlmError,
	type LlmObjectRequest,
	type LlmObjectResult,
	type LlmReasoning,
	type OutputMode,
} from '@famos/sdk';
import { generateText, jsonSchema, Output } from 'ai';
import {
	extractJson,
	NEXT_MODE,
	outputModeFor,
	reasoningFor,
	schemaInstruction,
} from '../output.ts';
import { type AiSdkLlmDeps, type LlmCalls, within } from './calls.ts';
import { effortOf, reasoningInBody } from './clients.ts';
import { toLlmError } from './errors.ts';

/** The longest a call waits for a rate limit to pass before it asks once more. */
const RATE_WAIT_MAX_MS = 10_000;

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

/** `generateObject`: a structured answer, asked in the output mode the model handles best. */
export function createGenerateObject(deps: AiSdkLlmDeps, calls: LlmCalls) {
	const { factory, logger, checkLimits, checkAreas, target, recorder, failureFields, policy } =
		calls;

	return {
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
				const failure = toLlmError(error, role.model);
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
					abortSignal: within(request.timeoutMs, request.signal),
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
					if (reasoning && toLlmError(error, role.model).code === 'rejected') {
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
					const failure = toLlmError(error, role.model);
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
	};
}
