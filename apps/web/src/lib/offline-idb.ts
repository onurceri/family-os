import {
	createMemoryStore,
	type FailedChange,
	type QueuedChange,
	type QueueStore,
} from './offline-queue.js';

/** A tiny promise wrapper over IndexedDB for the offline queue (no dependency). */
const DB_NAME = 'famos-offline';
const QUEUE = 'queue';
const FAILED = 'failed';

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			db.createObjectStore(QUEUE, { keyPath: 'key' });
			db.createObjectStore(FAILED, { keyPath: 'key' });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export function createIndexedDbStore(): QueueStore {
	let db: Promise<IDBDatabase> | null = null;
	const connection = () =>
		(db ??= open().catch((error: unknown) => {
			// A failed open is tried again by the next call, not remembered.
			db = null;
			throw error;
		}));

	async function run<T>(
		store: string,
		mode: IDBTransactionMode,
		work: (s: IDBObjectStore) => IDBRequest<T>,
	): Promise<T> {
		const database = await connection();
		return new Promise<T>((resolve, reject) => {
			const tx = database.transaction(store, mode);
			const request = work(tx.objectStore(store));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}

	return {
		list: () => run<QueuedChange[]>(QUEUE, 'readonly', (s) => s.getAll()),
		put: async (change) => void (await run(QUEUE, 'readwrite', (s) => s.put(change))),
		remove: async (key) => void (await run(QUEUE, 'readwrite', (s) => s.delete(key))),
		listFailed: () => run<FailedChange[]>(FAILED, 'readonly', (s) => s.getAll()),
		putFailed: async (failed) => void (await run(FAILED, 'readwrite', (s) => s.put(failed))),
		removeFailed: async (key) => void (await run(FAILED, 'readwrite', (s) => s.delete(key))),
		async clear() {
			await run(QUEUE, 'readwrite', (s) => s.clear());
			await run(FAILED, 'readwrite', (s) => s.clear());
		},
	};
}

/** How many times a call to the persistent store is tried before the change is kept in memory. */
export const PERSISTENT_ATTEMPTS = 2;

/**
 * The persistent store with a memory store beside it. A call that keeps failing is kept in
 * memory and `onDegraded` hears of it once (those changes are lost when the page closes); the
 * next call tries the persistent store again, and a list holds both, so nothing kept in memory
 * is hidden when storage comes back.
 */
export function withMemoryFallback(
	persistent: QueueStore | null,
	fallback: QueueStore,
	onDegraded: () => void,
): QueueStore {
	let told = false;
	const degraded = () => {
		if (told) return;
		told = true;
		onDegraded();
	};
	async function attempt<R>(call: (s: QueueStore) => Promise<R>): Promise<R | undefined> {
		if (!persistent) return undefined;
		for (let i = 0; i < PERSISTENT_ATTEMPTS; i++) {
			try {
				return await call(persistent);
			} catch {
				// Try again, then give up for this call.
			}
		}
		return undefined;
	}
	/** Writes to the persistent store, or to memory when it cannot. */
	async function write(
		call: (s: QueueStore) => Promise<void>,
		dropFromMemory: (s: QueueStore) => Promise<void>,
	): Promise<void> {
		const done = await attempt(async (s) => {
			await call(s);
			return true;
		});
		if (done) return dropFromMemory(fallback);
		degraded();
		return call(fallback);
	}
	/** Removes from both: an item may sit in either. */
	async function drop(call: (s: QueueStore) => Promise<void>): Promise<void> {
		await attempt(call);
		await call(fallback);
	}
	async function merged<T extends { key: string }>(
		call: (s: QueueStore) => Promise<T[]>,
	): Promise<T[]> {
		const stored = (await attempt(call)) ?? [];
		const kept = await call(fallback);
		if (kept.length === 0) return stored;
		const keys = new Set(stored.map((item) => item.key));
		return [...stored, ...kept.filter((item) => !keys.has(item.key))];
	}
	return {
		list: () => merged((s) => s.list()),
		put: (c) =>
			write(
				(s) => s.put(c),
				(s) => s.remove(c.key),
			),
		remove: (k) => drop((s) => s.remove(k)),
		listFailed: () => merged((s) => s.listFailed()),
		putFailed: (f) =>
			write(
				(s) => s.putFailed(f),
				(s) => s.removeFailed(f.key),
			),
		removeFailed: (k) => drop((s) => s.removeFailed(k)),
		clear: () => drop((s) => s.clear()),
	};
}

/** IndexedDB when the browser allows it (not in some private windows), else memory. */
export function createBrowserStore(onDegraded: () => void): QueueStore {
	return withMemoryFallback(
		typeof indexedDB === 'undefined' ? null : createIndexedDbStore(),
		createMemoryStore(),
		onDegraded,
	);
}
