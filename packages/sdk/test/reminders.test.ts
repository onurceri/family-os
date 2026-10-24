import { describe, expect, it } from 'vitest';
import { REMINDER_LATE_MS, reminderMissed, reminderStale } from '../src/index.ts';

describe('reminderStale', () => {
	const planned = { version: 7, date: '2026-10-24' };

	it('accepts a record that is as it was planned', () => {
		expect(reminderStale(planned, { version: 7, date: '2026-10-24' })).toBe(false);
	});

	it('refuses a record edited since', () => {
		expect(reminderStale(planned, { version: 8, date: '2026-10-24' })).toBe(true);
	});

	it('refuses a record whose due day moved or went away', () => {
		expect(reminderStale(planned, { version: 7, date: '2026-10-25' })).toBe(true);
		expect(reminderStale(planned, { version: 7, date: null })).toBe(true);
	});
});

describe('reminderMissed', () => {
	it('lets a reminder through within the grace period and drops older ones', () => {
		const now = 1_000_000_000;
		expect(reminderMissed(now - REMINDER_LATE_MS, now)).toBe(false);
		expect(reminderMissed(now - REMINDER_LATE_MS - 1, now)).toBe(true);
		expect(reminderMissed(now + 1, now)).toBe(false);
	});
});
