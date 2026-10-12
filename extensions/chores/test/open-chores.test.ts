import { describe, expect, it } from 'vitest';
import { hasOpenChore } from '../src/web/open-chores.ts';

describe('hasOpenChore', () => {
	it('is false when only finished chores remain, so "Mine" can say nothing waits', () => {
		expect(hasOpenChore([])).toBe(false);
		expect(hasOpenChore([{ nextDue: null }, { nextDue: null }])).toBe(false);
	});

	it('is true while any chore still has a due date', () => {
		expect(hasOpenChore([{ nextDue: null }, { nextDue: '2026-10-12' }])).toBe(true);
	});
});
