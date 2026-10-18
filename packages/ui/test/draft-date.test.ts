import { describe, expect, it } from 'vitest';
import { draftDate } from '../src/slots.ts';

describe('draftDate', () => {
	it('writes a date in the reader’s words and the region’s order', () => {
		expect(draftDate('2026-09-02', { dateLocale: 'en-GB' })).toBe('2 September 2026');
		expect(draftDate('2026-09-02', { dateLocale: 'en-US' })).toBe('September 2, 2026');
		expect(draftDate('2026-09-02', { dateLocale: 'tr-TR' })).toBe('2 Eylül 2026');
	});

	it('is not moved by the machine’s time zone', () => {
		expect(draftDate('2026-01-01', { dateLocale: 'en-GB' })).toBe('1 January 2026');
		expect(draftDate('2026-12-31', { dateLocale: 'en-GB' })).toBe('31 December 2026');
	});

	it('gives back what is not a calendar date, so an odd answer still shows', () => {
		for (const odd of ['next Tuesday', '2026-02-30', '2026-9-2', '', '2026-09-02T10:00'])
			expect(draftDate(odd, { dateLocale: 'en-GB' })).toBe(odd);
	});
});
