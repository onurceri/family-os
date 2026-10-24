import { describe, expect, it } from 'vitest';
import { withMemoryFallback } from './offline-idb.js';
import { createMemoryStore, type QueuedChange, type QueueStore } from './offline-queue.js';

const change = (key: string): QueuedChange => ({ key }) as QueuedChange;

/** A persistent store that fails the first `failures` calls of any kind. */
function flaky(failures: number): { store: QueueStore; calls: () => number } {
	const inner = createMemoryStore();
	let left = failures;
	let calls = 0;
	const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => {
		return async (...a: A): Promise<R> => {
			calls++;
			if (left > 0) {
				left--;
				throw new Error('quota');
			}
			return fn(...a);
		};
	};
	return {
		calls: () => calls,
		store: {
			list: guard(() => inner.list()),
			put: guard((c: QueuedChange) => inner.put(c)),
			remove: guard((k: string) => inner.remove(k)),
			listFailed: guard(() => inner.listFailed()),
			putFailed: guard((f) => inner.putFailed(f)),
			removeFailed: guard((k: string) => inner.removeFailed(k)),
			clear: guard(() => inner.clear()),
		},
	};
}

describe('withMemoryFallback', () => {
	it('retries a failed call on the persistent store before keeping the change in memory', async () => {
		const { store } = flaky(1);
		let told = 0;
		const s = withMemoryFallback(store, createMemoryStore(), () => told++);
		await s.put(change('a'));
		expect(told).toBe(0);
		expect((await s.list()).map((c) => c.key)).toEqual(['a']);
	});

	it('tells the person once when changes can only be kept in memory', async () => {
		const { store } = flaky(100);
		let told = 0;
		const s = withMemoryFallback(store, createMemoryStore(), () => told++);
		await s.put(change('a'));
		await s.put(change('b'));
		expect(told).toBe(1);
		expect((await s.list()).map((c) => c.key)).toEqual(['a', 'b']);
	});

	it('returns to the persistent store when it works again and still shows what memory holds', async () => {
		const { store } = flaky(2);
		const s = withMemoryFallback(store, createMemoryStore(), () => {});
		await s.put(change('a')); // both attempts fail: kept in memory
		await s.put(change('b')); // persistent works again
		expect((await s.list()).map((c) => c.key).sort()).toEqual(['a', 'b']);
		await s.remove('a');
		expect((await s.list()).map((c) => c.key)).toEqual(['b']);
	});

	it('uses memory with a notice when there is no persistent store', async () => {
		let told = 0;
		const s = withMemoryFallback(null, createMemoryStore(), () => told++);
		await s.put(change('a'));
		expect(told).toBe(1);
		expect(await s.list()).toHaveLength(1);
	});
});
