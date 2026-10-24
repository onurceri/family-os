import { describe, expect, it } from 'vitest';
import { createMemoryStore, OfflineQueue, type SendResult } from './offline-queue.js';
import { sendAction } from './offline-send.js';

/** A server that never answers; it only gives up when the request is aborted. */
const silentServer: typeof fetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
	});

describe('sendAction', () => {
	it('gives up on a request that gets no answer', async () => {
		await expect(sendAction('x.do', {}, 'k', silentServer, 20)).rejects.toBeDefined();
	});

	it('returns any answer, even an error, with its status', async () => {
		const answer: typeof fetch = async () => new Response('{"error":{}}', { status: 409 });
		const result = await sendAction('x.do', {}, 'k', answer, 1000);
		expect(result.status).toBe(409);
	});
});

describe('a send that never answers', () => {
	it('does not freeze the queue: the flush settles and the change waits for a later try', async () => {
		let now = 1_000;
		const queue = new OfflineQueue({
			store: createMemoryStore(),
			send: (actionId, input, key): Promise<SendResult> =>
				sendAction(actionId, input, key, silentServer, 20),
			memberId: () => 'member_a',
			isOnline: () => true,
			now: () => now,
			newKey: () => 'key_1',
		});
		await queue.load();
		// Queued while offline-capable sends fail: first run itself times out and queues.
		const first = await queue.run('x.do', { a: 1 }, { offline: true });
		expect(first.queued).toBe(true);
		await queue.flush({ force: true });
		expect(queue.waiting()).toHaveLength(1);
		now += 10 * 60_000;
		// A later flush starts a new attempt instead of returning a promise that never settles.
		await queue.flush({ force: true });
		expect(queue.waiting()).toHaveLength(1);
	});
});
