import { beforeEach, describe, expect, it } from 'vitest';
import {
	ActionError,
	backoffMs,
	createMemoryStore,
	OfflineQueue,
	type QueueStore,
	type SendResult,
} from './offline-queue.js';
import { refusalOfError } from './refusal.js';

interface Sent {
	actionId: string;
	input: unknown;
	key: string;
}

let store: QueueStore;
let queue: OfflineQueue;
let me: string | null;
let online: boolean;
let now: number;
let sent: Sent[];
/** What the fake server answers; a function may throw to simulate no connection. */
let answer: (call: Sent) => SendResult;
let keys: number;

const ok = (): SendResult => ({ status: 200, body: { status: 'applied', output: { done: true } } });
const refused = (status: number, message: string): SendResult => ({
	status,
	body: { error: { code: 'x', message } },
});

beforeEach(() => {
	store = createMemoryStore();
	me = 'member_a';
	online = true;
	now = 1_000;
	sent = [];
	keys = 0;
	answer = ok;
	queue = new OfflineQueue({
		store,
		memberId: () => me,
		isOnline: () => online,
		now: () => now,
		newKey: () => `key_${++keys}`,
		send: async (actionId, input, key) => {
			const call = { actionId, input, key };
			sent.push(call);
			return answer(call);
		},
	});
});

const noNetwork = () => {
	throw new TypeError('Failed to fetch');
};

describe('running actions', () => {
	it('sends online calls with a fresh key and returns the result', async () => {
		const result = await queue.run('lists.checkShoppingItem', { id: 'x' }, { offline: true });
		expect(result).toEqual({ queued: false, status: 'applied', output: { done: true } });
		expect(sent).toEqual([
			{ actionId: 'lists.checkShoppingItem', input: { id: 'x' }, key: 'key_1' },
		]);
		expect(queue.changes).toHaveLength(0);
	});

	it('queues an offline-capable call when the network fails', async () => {
		answer = noNetwork;
		const result = await queue.run(
			'lists.addShoppingItems',
			{ items: [] },
			{ offline: true, label: 'Add milk' },
		);
		expect(result).toEqual({ queued: true });
		expect(queue.waiting()).toMatchObject([
			{ key: 'key_1', actionId: 'lists.addShoppingItems', memberId: 'member_a', label: 'Add milk' },
		]);
		expect(await store.list()).toHaveLength(1);
	});

	it('queues without trying when the browser says it is offline', async () => {
		online = false;
		expect(await queue.run('lists.addShoppingItems', {}, { offline: true })).toEqual({
			queued: true,
		});
		expect(sent).toHaveLength(0);
	});

	it('does not queue calls that are not flagged offline', async () => {
		answer = noNetwork;
		await expect(queue.run('lists.deleteTask', { id: 'x' })).rejects.toThrow('Failed to fetch');
		expect(queue.changes).toHaveLength(0);
	});

	it('throws HTTP errors as they are and never queues them', async () => {
		answer = () => refused(403, 'Not allowed');
		const error = await queue.run('lists.completeTask', {}, { offline: true }).catch((e) => e);
		expect(error).toBeInstanceOf(ActionError);
		expect(error).toMatchObject({ status: 403, code: 'x', message: 'Not allowed' });
		answer = () => refused(500, 'Boom');
		await expect(queue.run('lists.completeTask', {}, { offline: true })).rejects.toMatchObject({
			status: 500,
		});
		expect(queue.changes).toHaveLength(0);
	});

	it('keeps why a change was refused, so the app can say it in words', async () => {
		answer = () => ({
			status: 403,
			body: { error: { code: 'forbidden', message: 'Not allowed', reason: 'approval' } },
		});
		const error = await queue.run('lists.completeTask', {}).catch((e) => e);
		expect(error).toMatchObject({ status: 403, reason: 'approval' });
		expect(refusalOfError(error)).toEqual({ reason: 'approval' });
	});

	it('refuses unsafe action ids', async () => {
		await expect(queue.run('../x', {})).rejects.toThrow('Invalid action id');
	});

	it('keeps earlier changes first: a new call joins a non-empty queue', async () => {
		answer = noNetwork;
		await queue.run('lists.addShoppingItems', { n: 1 }, { offline: true });
		answer = ok;
		const result = await queue.run('lists.addShoppingItems', { n: 2 }, { offline: true });
		expect(result).toEqual({ queued: true });
		await queue.flush({ force: true });
		expect(sent.slice(-2).map((s) => (s.input as { n: number }).n)).toEqual([1, 2]);
		expect(queue.waiting()).toHaveLength(0);
	});
});

describe('replay', () => {
	async function queueTwo() {
		answer = noNetwork;
		await queue.run('lists.addShoppingItems', { n: 1 }, { offline: true });
		now += 10;
		await queue.run('lists.checkShoppingItem', { n: 2 }, { offline: true });
		sent = [];
	}

	it('sends in creation order with the original keys, then empties the queue', async () => {
		await queueTwo();
		answer = ok;
		await queue.flush({ force: true });
		expect(sent.map((s) => s.key)).toEqual(['key_1', 'key_2']);
		expect(queue.waiting()).toHaveLength(0);
		expect(await store.list()).toHaveLength(0);
	});

	it('keeps changes and order on network trouble, with backoff', async () => {
		await queueTwo();
		answer = noNetwork;
		await queue.flush({ force: true });
		expect(sent).toHaveLength(1); // stopped at the first
		expect(queue.waiting()).toHaveLength(2);
		expect(queue.waiting()[0]).toMatchObject({ attempts: 1, nextAttemptAt: now + backoffMs(1) });
		sent = [];
		await queue.flush(); // too early
		expect(sent).toHaveLength(0);
		now += backoffMs(1);
		answer = ok;
		await queue.flush();
		expect(sent).toHaveLength(2);
		expect(queue.waiting()).toHaveLength(0);
	});

	it('keeps changes on server errors, rate limits and a lost session', async () => {
		for (const status of [500, 503, 429, 401]) {
			queue = new OfflineQueue({ ...depsOf(), memberId: () => me });
			await queueTwoWith(queue);
			answer = () => refused(status, 'later');
			await queue.flush({ force: true });
			expect(queue.waiting()).toHaveLength(2);
			expect(queue.failed).toHaveLength(0);
			await queue.clear();
		}
	});

	it('moves a refused change to the could-not-be-saved list and goes on', async () => {
		await queueTwo();
		now += 5;
		answer = (call) => (call.key === 'key_1' ? refused(404, 'Item not found') : ok());
		await queue.flush({ force: true });
		expect(sent.map((s) => s.key)).toEqual(['key_1', 'key_2']);
		expect(queue.waiting()).toHaveLength(0);
		expect(queue.failedForMe()).toEqual([
			expect.objectContaining({
				key: 'key_1',
				actionId: 'lists.addShoppingItems',
				status: 404,
				message: 'Item not found',
				failedAt: now,
			}),
		]);
		// The stored notice holds no input.
		expect(JSON.stringify(await store.listFailed())).not.toContain('"n":1');
		await queue.dismissFailed();
		expect(queue.failed).toHaveLength(0);
		expect(await store.listFailed()).toHaveLength(0);
	});

	it('never sends another member’s changes', async () => {
		await queueTwo();
		me = 'member_b';
		answer = ok;
		await queue.flush({ force: true });
		expect(sent).toHaveLength(0);
		expect(queue.waiting()).toHaveLength(0);
		expect(queue.changes).toHaveLength(2); // still stored for their owner
		me = 'member_a';
		await queue.flush({ force: true });
		expect(sent).toHaveLength(2);
	});

	it('clear (sign-out) removes queued and failed changes from the store', async () => {
		await queueTwo();
		answer = () => refused(400, 'bad');
		await queue.flush({ force: true });
		await queue.clear();
		expect(await store.list()).toHaveLength(0);
		expect(await store.listFailed()).toHaveLength(0);
		expect(queue.changes).toHaveLength(0);
	});

	it('survives a reload: load() restores the queue in order', async () => {
		await queueTwo();
		const again = new OfflineQueue({ ...depsOf(), memberId: () => me });
		await again.load();
		expect(again.waiting().map((c) => c.key)).toEqual(['key_1', 'key_2']);
	});

	it('runs only one flush at a time', async () => {
		await queueTwo();
		answer = ok;
		await Promise.all([queue.flush({ force: true }), queue.flush({ force: true })]);
		expect(sent).toHaveLength(2);
	});
});

function depsOf() {
	return {
		store,
		isOnline: () => online,
		now: () => now,
		newKey: () => `key_${++keys}`,
		send: async (actionId: string, input: unknown, key: string) => {
			const call = { actionId, input, key };
			sent.push(call);
			return answer(call);
		},
	};
}

async function queueTwoWith(q: OfflineQueue) {
	answer = noNetwork;
	await q.run('lists.addShoppingItems', { n: 1 }, { offline: true });
	now += 10;
	await q.run('lists.checkShoppingItem', { n: 2 }, { offline: true });
	sent = [];
}
