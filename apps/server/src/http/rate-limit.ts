import { addressKey } from '@famos/adapters/identity-betterauth';

export { addressKey };

/** The most keys one limiter remembers; past it the oldest go first. */
const MAX_KEYS = 5000;

export type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * A small in-memory fixed-window limiter (per process: a restart only forgets it). Used for
 * unauthenticated routes that create records, such as starting a display pairing. It remembers at
 * most 5000 keys; when full, expired ones go first and then the oldest, so a flood of keys cannot
 * grow memory.
 */
export function createRateLimiter(options: { max: number; windowMs: number; now?: () => number }) {
	const now = options.now ?? Date.now;
	// A Map iterates in insertion order, and a key is only inserted when its window starts, so the
	// first keys are the oldest windows.
	const hits = new Map<string, { count: number; resetAt: number }>();
	return {
		/** Counts one hit for `key`; false when the key is over its limit for this window. */
		hit(rawKey: string): boolean {
			const key = addressKey(rawKey);
			const at = now();
			const entry = hits.get(key);
			if (!entry || entry.resetAt <= at) {
				hits.delete(key);
				if (hits.size >= MAX_KEYS) {
					for (const [k, v] of hits) if (v.resetAt <= at) hits.delete(k);
					for (const k of hits.keys()) {
						if (hits.size < MAX_KEYS) break;
						hits.delete(k);
					}
				}
				hits.set(key, { count: 1, resetAt: at + options.windowMs });
				return true;
			}
			entry.count++;
			return entry.count <= options.max;
		},
		/** How many keys are remembered. */
		size: () => hits.size,
	};
}
