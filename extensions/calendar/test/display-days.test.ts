import { describe, expect, it } from 'vitest';
import { nextDays } from '../src/web/display-days.js';

describe('display week days', () => {
	it('starts today, even on the last day of a Monday-first week', () => {
		// Sunday 18 October 2026.
		expect(nextDays('2026-10-18')).toEqual([
			'2026-10-18',
			'2026-10-19',
			'2026-10-20',
			'2026-10-21',
			'2026-10-22',
			'2026-10-23',
			'2026-10-24',
		]);
	});

	it('crosses a month and a year', () => {
		expect(nextDays('2026-12-29').at(-1)).toBe('2027-01-04');
	});
});
