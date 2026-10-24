import type { SendResult } from './offline-queue.js';

/** A queued change that gets no answer in this time counts as not sent and is tried again later. */
export const SEND_TIMEOUT_MS = 20_000;

/**
 * Posts one action. Throws when there is no connection or no answer in time; any answer, even
 * an error, is returned.
 */
export async function sendAction(
	actionId: string,
	input: unknown,
	key: string,
	fetcher: typeof fetch = fetch,
	timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendResult> {
	const response = await fetcher(`/api/v1/actions/${actionId}`, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json', 'idempotency-key': key },
		body: JSON.stringify(input),
		// Covers reading the body too: a half-open connection must not hold the queue.
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		// Not JSON (a proxy error page): the status decides.
	}
	return { status: response.status, body };
}
