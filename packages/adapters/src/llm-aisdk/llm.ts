import type { LlmPort } from '@famos/sdk';
import { type AiSdkLlmDeps, createCalls } from './llm/calls.ts';
import { createChat } from './llm/chat.ts';
import { createEmbed } from './llm/embed.ts';
import { createGenerateObject } from './llm/object.ts';
import { createTranscribe } from './llm/transcribe.ts';

export type { AiSdkLlmDeps } from './llm/calls.ts';
export { ANSWER_BY_SHARE } from './llm/chat.ts';
export {
	type EmbeddingFactory,
	type ModelFactory,
	type ModelOptions,
	openAiCompatibleEmbedder,
	openAiCompatibleModel,
} from './llm/clients.ts';
export { providerReasonOf, retryAfterOf } from './llm/errors.ts';

/**
 * LlmPort on the AI SDK: resolves the role to a provider and model, enforces the
 * monthly limits, calls the model with the request's timeout and records every call in
 * `ai_usage` (also failures). Prompts and outputs are never logged.
 */
export function createAiSdkLlm(deps: AiSdkLlmDeps): LlmPort {
	const calls = createCalls(deps);
	const { policy } = calls;
	const { generateObject } = createGenerateObject(deps, calls);
	const { chat } = createChat(deps, calls);
	const { embed } = createEmbed(deps, calls);
	const { transcribe } = createTranscribe(deps, calls);

	return {
		policy,
		generateObject,
		chat,
		embed,
		transcribe,
	};
}
