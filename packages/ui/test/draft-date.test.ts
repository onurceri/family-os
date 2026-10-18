import { describe, expect, it } from 'vitest';
import { draftDate } from '../src/slots.ts';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const gb = { dateLocale: 'en-GB' };

describe('draftDate', () => {
	it('writes a day with its weekday in the reader’s words and the region’s order', () => {
		expect(draftDate('2026-09-02', gb, NOW)).toBe('Wednesday 2 September');
		expect(draftDate('2026-09-02', { dateLocale: 'en-US' }, NOW)).toBe('Wednesday, September 2');
		expect(draftDate('2026-09-02', { dateLocale: 'tr-TR' }, NOW)).toBe('2 Eylül Çarşamba');
	});

	it('names the year only when it is not the current one', () => {
		expect(draftDate('2027-10-13', gb, NOW)).toBe('Wednesday, 13 October 2027');
		expect(draftDate('2025-12-31', gb, NOW)).toBe('Wednesday, 31 December 2025');
	});

	it('takes the current year in the family’s time zone', () => {
		const newYearsEve = Date.parse('2026-12-31T23:30:00Z');
		expect(draftDate('2026-12-31', { ...gb, timeZone: 'UTC' }, newYearsEve)).toBe(
			'Thursday 31 December',
		);
		expect(draftDate('2026-12-31', { ...gb, timeZone: 'Pacific/Auckland' }, newYearsEve)).toBe(
			'Thursday, 31 December 2026',
		);
	});

	it('is not moved by the machine’s time zone', () => {
		expect(draftDate('2026-01-01', gb, NOW)).toBe('Thursday 1 January');
		expect(draftDate('2026-12-31', gb, NOW)).toBe('Thursday 31 December');
	});

	it('gives back what is not a calendar date, so an odd answer still shows', () => {
		for (const odd of ['next Tuesday', '2026-02-30', '2026-9-2', '', '2026-09-02T10:00'])
			expect(draftDate(odd, gb, NOW)).toBe(odd);
	});
});
