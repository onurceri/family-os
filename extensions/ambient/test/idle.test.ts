import { describe, expect, it } from 'vitest';
import { shouldCover } from '../src/web/idle.js';

const base = { idle: true, covering: false, lastActivity: 0, now: 5 * 60_000, idleMinutes: 5 };

describe('when ambient mode takes over', () => {
	it('covers the screen once nobody has touched it for the idle time', () => {
		expect(shouldCover(base)).toBe(true);
		expect(shouldCover({ ...base, now: 5 * 60_000 - 1 })).toBe(false);
	});

	it('does not take over a screen that has pages, however long it is left', () => {
		expect(shouldCover({ ...base, idle: false, now: 24 * 60 * 60_000 })).toBe(false);
	});

	it('has nothing to start while it already covers the screen', () => {
		expect(shouldCover({ ...base, covering: true })).toBe(false);
	});
});
