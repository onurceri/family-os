import type { ExternalHttp, LlmPort } from '@famos/sdk';

/**
 * A model port whose every call also ends when `signal` aborts, so a job run that timed out
 * stops its model calls without the handler passing anything.
 */
export function llmWithin(llm: LlmPort, signal: AbortSignal): LlmPort {
	const bound = <R extends { signal?: AbortSignal }>(request: R): R => ({
		...request,
		signal: request.signal ? AbortSignal.any([request.signal, signal]) : signal,
	});
	return {
		...llm,
		generateObject: (request) => llm.generateObject(bound(request)),
		chat: (request) => llm.chat(bound(request)),
		transcribe: (request) => llm.transcribe(bound(request)),
		embed: (request) => llm.embed(bound(request)),
	};
}

/** Guarded web calls that also end when `signal` aborts (see `llmWithin`). */
export function httpWithin(http: ExternalHttp, signal: AbortSignal): ExternalHttp {
	const bound = <R extends { signal?: AbortSignal }>(request: R): R => ({
		...request,
		signal: request.signal ? AbortSignal.any([request.signal, signal]) : signal,
	});
	return {
		get: (request) => http.get(bound(request)),
		post: (request) => http.post(bound(request)),
	};
}
