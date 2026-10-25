import { type LlmEmbedRequest, type LlmEmbedResult, LlmError } from '@famos/sdk';
import { embedMany } from 'ai';
import { type AiSdkLlmDeps, type LlmCalls, within } from './calls.ts';
import { toLlmError } from './errors.ts';

/** `embed`: one vector per text. */
export function createEmbed(deps: AiSdkLlmDeps, calls: LlmCalls) {
	const { embedder, logger, checkLimits, checkAreas, target, recorder, policy } = calls;

	return {
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
				const failure = toLlmError(error, role.model);
				await record({ errorCode: failure.code });
				throw failure;
			}
			await checkLimits();

			// Known once the provider answered: an answer that is then refused was still charged.
			let tokens: number | null = null;
			const free = provider.kind === 'ollama' ? 0 : null;
			try {
				const result = await embedMany({
					model: embedder(provider, role.model),
					values: [...request.texts],
					maxRetries: 1,
					abortSignal: within(request.timeoutMs, request.signal),
				});
				tokens = Number.isFinite(result.usage.tokens) ? result.usage.tokens : null;
				const vectors = result.embeddings.map((e) => Float32Array.from(e));
				const dimensions = vectors[0]?.length ?? 0;
				if (
					vectors.length !== request.texts.length ||
					dimensions === 0 ||
					vectors.some((v) => v.length !== dimensions)
				) {
					throw new LlmError('invalid_output', 'The model did not return one vector per text');
				}
				await record({ input: tokens, cost: free });
				return { vectors, model: `${provider.id}:${role.model}`, dimensions };
			} catch (error) {
				// The SDK throws a plain error when the provider returns fewer vectors than texts.
				const failure =
					error instanceof Error && /embeddings, but received/.test(error.message)
						? new LlmError('invalid_output', 'The model did not return one vector per text', {
								cause: error,
							})
						: toLlmError(error, role.model);
				await record({
					errorCode: failure.code,
					input: tokens,
					cost: tokens === null ? null : free,
				});
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
	};
}
