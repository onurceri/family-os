/**
 * The in-memory counters behind sign-in locks. A restart clears them, which is acceptable for a
 * single family server: a guesser gains one fresh budget per restart, and only an admin restarts.
 */

/** The most keys one counter remembers by default; a household never comes near it, a flood of addresses does. */
export const MAX_KEYS = 10_000;

/**
 * Stores `value` under `key` as the newest entry; when the map is full the oldest entries go
 * first (a Map iterates in insertion order), so a flood of keys cannot grow memory.
 */
function remember<V>(map: Map<string, V>, key: string, value: V, maxKeys: number) {
	map.delete(key);
	for (const oldest of map.keys()) {
		if (map.size < maxKeys) break;
		map.delete(oldest);
	}
	map.set(key, value);
}

/**
 * Locks a key after `after` failures (counted within `windowMs` when given, else until a success)
 * for `lockMs`.
 */
export function createLockout(options: {
	after: number;
	lockMs: number;
	windowMs?: number;
	now: () => number;
	maxKeys?: number;
}) {
	const { after, lockMs, windowMs, now, maxKeys = MAX_KEYS } = options;
	const failures = new Map<string, { count: number; since: number; until: number }>();
	return {
		/** Milliseconds left on the lock, or 0 when the key is not locked. */
		lockedFor(key: string) {
			const entry = failures.get(key);
			if (!entry || entry.until <= now()) {
				if (entry?.until) failures.delete(key);
				return 0;
			}
			return entry.until - now();
		},
		record(key: string, ok: boolean) {
			if (ok) {
				failures.delete(key);
				return;
			}
			const at = now();
			const current = failures.get(key);
			const entry =
				!current || (windowMs !== undefined && current.since + windowMs <= at)
					? { count: 0, since: at, until: 0 }
					: current;
			entry.count += 1;
			if (entry.count >= after) {
				entry.count = 0;
				entry.since = at;
				entry.until = at + lockMs;
			}
			remember(failures, key, entry, maxKeys);
		},
		/** Takes back one counted failure (an attempt counted ahead of its check that proved nothing, or was right). */
		forgive(key: string) {
			const entry = failures.get(key);
			if (entry && entry.count > 0) entry.count -= 1;
		},
		/** How many keys are remembered. */
		size: () => failures.size,
	};
}

/** Counts failures per key in fixed windows; at `max` the key waits out its window. */
export function createAddressLimit(options: {
	max: number;
	windowMs: number;
	now: () => number;
	maxKeys?: number;
}) {
	const { max, windowMs, now, maxKeys = MAX_KEYS } = options;
	const windows = new Map<string, { count: number; ends: number }>();
	return {
		/** Milliseconds the key must wait, or 0. */
		waitFor(key: string) {
			const entry = windows.get(key);
			if (!entry || entry.ends <= now()) {
				if (entry) windows.delete(key);
				return 0;
			}
			return entry.count >= max ? entry.ends - now() : 0;
		},
		fail(key: string) {
			const current = windows.get(key);
			if (current && current.ends > now()) {
				current.count += 1;
				return;
			}
			remember(windows, key, { count: 1, ends: now() + windowMs }, maxKeys);
		},
		/** Takes back one counted failure (see the lockout's `forgive`). */
		forgive(key: string) {
			const entry = windows.get(key);
			if (!entry || entry.ends <= now()) return;
			entry.count -= 1;
			if (entry.count <= 0) windows.delete(key);
		},
		/** How many keys are remembered. */
		size: () => windows.size,
	};
}
