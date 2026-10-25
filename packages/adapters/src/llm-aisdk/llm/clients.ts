import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LlmReasoning } from '@famos/sdk';
import type { EmbeddingModel, LanguageModel } from 'ai';
import type { ResolvedProvider } from '../settings.ts';

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
export const effortOf = (level: LlmReasoning) => (level === 'off' ? ('none' as const) : level);

/**
 * Whether the reasoning level goes to the provider as a top-level option (the SDK sends it
 * as `reasoning_effort`). OpenRouter takes it in a `reasoning` object instead, added in
 * `transformRequestBody`.
 */
export const reasoningInBody = (provider: ResolvedProvider) => provider.kind === 'openrouter';

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
