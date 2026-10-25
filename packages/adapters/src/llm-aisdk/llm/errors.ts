import { isLlmError, LlmError } from '@famos/sdk';
import { APICallError, NoObjectGeneratedError, RetryError } from 'ai';

const REASON_MAX = 200;

/** Control characters and runs of whitespace become one space; cut to `REASON_MAX`. */
export const boundedReason = (text: string): string =>
	text
		.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
		.trim()
		.slice(0, REASON_MAX);

/**
 * What a provider says went wrong, from the error object of its JSON body (a code and a message,
 * bounded): never the body itself, which a gateway may fill with the request it refused.
 */
export function providerReasonOf(body: string | undefined): string | null {
	if (!body) return null;
	try {
		const parsed: unknown = JSON.parse(body);
		const error =
			typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : null;
		const fields =
			typeof error === 'object' && error !== null
				? (error as { code?: unknown; message?: unknown })
				: typeof error === 'string'
					? { message: error }
					: (parsed as { message?: unknown } | null);
		const code =
			fields &&
			'code' in fields &&
			(typeof fields.code === 'string' || typeof fields.code === 'number')
				? String(fields.code)
				: '';
		const message = typeof fields?.message === 'string' ? fields.message : '';
		const reason = boundedReason([code, message].filter(Boolean).join(': '));
		return reason || null;
	} catch {
		return null;
	}
}

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

/**
 * Whether a gateway's error body says the provider behind the model failed (OpenRouter puts the
 * upstream's name in `error.metadata.provider_name` and words the message "Provider returned
 * error"), as opposed to the gateway not knowing the model.
 */
function isGatewayUpstreamFailure(body: string | undefined): boolean {
	if (!body) return false;
	try {
		const error: unknown = (JSON.parse(body) as { error?: unknown } | null)?.error;
		if (typeof error !== 'object' || error === null) return false;
		const { message, metadata } = error as { message?: unknown; metadata?: unknown };
		const provider =
			typeof metadata === 'object' && metadata !== null
				? (metadata as { provider_name?: unknown }).provider_name
				: undefined;
		return (
			(typeof provider === 'string' && provider !== '') || message === 'Provider returned error'
		);
	} catch {
		return false;
	}
}

export function toLlmError(error: unknown, model?: string): LlmError {
	if (isLlmError(error)) return error;
	// The AI SDK's own retry gave up: what failed is its last error (a 429 keeps its wait).
	if (RetryError.isInstance(error) && error.lastError !== undefined)
		return toLlmError(error.lastError, model);
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
				'No provider of this model meets the data rules: turn off "Only providers that keep no data" in AI privacy, choose another model, or check the privacy settings of the OpenRouter account',
				{ cause: error },
			);
		}
		if (status === 404) {
			// A gateway (OpenRouter) answers 404 when the provider behind the model fails: the model
			// exists, so asking again later can work.
			if (isGatewayUpstreamFailure(error.responseBody)) {
				return new LlmError(
					'unavailable',
					'The provider behind the model is not answering (HTTP 404 from the gateway)',
					{ cause: error },
				);
			}
			return new LlmError(
				'model_not_found',
				model
					? `The provider does not know the model "${model}"`
					: 'The provider does not know the model',
				{ cause: error },
			);
		}
		if (status === 400 || status === 422) {
			// Gateways (OpenRouter) put the upstream reason in the body, not in the message.
			const reason = providerReasonOf(error.responseBody) ?? boundedReason(error.message);
			return new LlmError('rejected', `The provider rejected the request: ${reason}`.trim(), {
				cause: error,
			});
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
