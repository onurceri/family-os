import { repoVocabulary } from '@famos/testing';
import { dateWords, isUncertainDate } from '@famos/time';
import { describe, expect, it } from 'vitest';
import { datePaths, dateTable } from '../src/server/dates.ts';
import { clockTimes } from '../src/server/process.ts';

/** The date words of the repository's catalogs and bundled language packs. */
const words = dateWords(repoVocabulary());

import { regionNote } from '../src/server/process.ts';

describe('date help', () => {
	it('lists two weeks with weekdays and week labels', () => {
		const table = dateTable('2026-10-06'); // a Tuesday
		expect(table).toContain('- Tuesday 2026-10-06 (today)');
		expect(table).toContain('- Wednesday 2026-10-07 (tomorrow)');
		expect(table).toContain('- Thursday 2026-10-08 (this week)');
		expect(table).toContain('- Thursday 2026-10-15 (next week)');
		expect(table).toContain('- Tuesday 2026-10-20 (the week after)');
	});

	it('flags dates whose source names no day, ignoring times', () => {
		for (const [text, date] of [
			['next Thursday', '2026-10-15'],
			['next Thursday at 4:30pm', '2026-10-15'],
			['gelecek perşembe', '2026-10-15'],
			["Cuma günü saat 15:00'te", '2026-10-09'],
			["Cuma 9'da", '2026-10-09'],
			['end of the month', '2026-10-31'],
			['ay sonu', '2026-10-31'],
			['', '2026-10-09'],
			[undefined, '2026-10-09'],
		] as const) {
			expect(isUncertainDate(text, date, words), String(text)).toBe(true);
		}
	});

	it('accepts dates that match their source', () => {
		for (const [text, date] of [
			['16 Ekim Cuma', '2026-10-16'],
			['on the 15th', '2026-10-15'],
			["ayın 15'i", '2026-10-15'],
			['3/11', '2026-11-03'],
			['3 Kasım 2026 Salı saat 10:15', '2026-11-03'],
			['yarın sabah', '2026-10-07'],
			['tomorrow at 9', '2026-10-07'],
			['bugün', '2026-10-06'],
			['Cumartesi 24 Ekim', '2026-10-24'],
		] as const) {
			expect(isUncertainDate(text, date, words), text).toBe(false);
		}
	});

	it('flags dates that disagree with the day number or weekday of their source', () => {
		// 9 October 2026 is a Friday.
		expect(isUncertainDate('9 Ekim Perşembe', '2026-10-08', words)).toBe(true);
		expect(isUncertainDate('9 Ekim Perşembe', '2026-10-09', words)).toBe(true);
		expect(isUncertainDate('Friday the 9th', '2026-10-09', words)).toBe(false);
		expect(isUncertainDate('Pazartesi 12 Ekim', '2026-10-12', words)).toBe(false);
		expect(isUncertainDate('Pazar 12 Ekim', '2026-10-12', words)).toBe(true);
	});

	it('finds date fields in an input', () => {
		expect(
			datePaths({ title: 'x', date: '2026-10-08', endDate: '2026-10-09', startTime: '10:00' }),
		).toEqual(['date', 'endDate']);
		expect(datePaths({ title: 'x', dueDate: '2026-10-08' })).toEqual(['dueDate']);
	});

	it('labels the weeks from the family first day of the week', () => {
		// Sunday 4 October starts the week for a Sunday-first family.
		const table = dateTable('2026-10-06', 7); // a Tuesday
		expect(table).toContain('- Saturday 2026-10-10 (this week)');
		expect(table).toContain('- Sunday 2026-10-11 (next week)');
		expect(dateTable('2026-10-06', 1)).toContain('- Sunday 2026-10-11 (this week)');
		expect(dateTable('2026-10-06', 1)).toContain('- Monday 2026-10-12 (next week)');
	});

	it('settles all-numeric dates by the family order', () => {
		// "03/04": 3 April for day-first families, 4 March for month-first families.
		expect(isUncertainDate('03/04', '2026-04-03', words, 'DMY')).toBe(false);
		expect(isUncertainDate('03/04', '2026-03-04', words, 'DMY')).toBe(true);
		expect(isUncertainDate('03/04', '2026-03-04', words, 'MDY')).toBe(false);
		expect(isUncertainDate('03/04', '2026-04-03', words, 'MDY')).toBe(true);
		expect(isUncertainDate('10/8/2026', '2026-08-10', words, 'DMY')).toBe(false);
		expect(isUncertainDate('10/8/2026', '2026-10-08', words, 'DMY')).toBe(true);
		// Not ambiguous: a number above 12 or equal numbers.
		expect(isUncertainDate('13/04', '2026-04-13', words, 'MDY')).toBe(false);
		expect(isUncertainDate('05/05', '2026-05-05', words, 'MDY')).toBe(false);
		// The default order is day first.
		expect(isUncertainDate('3/11', '2026-11-03', words)).toBe(false);
	});

	it('tells the model how the family writes dates and times', () => {
		expect(regionNote('DMY', 'h23')).toContain('day first: 03/04 means 3 April');
		expect(regionNote('DMY', 'h23')).toContain('24-hour clock');
		expect(regionNote('MDY', 'h12')).toContain('month first: 03/04 means March 4');
		expect(regionNote('MDY', 'h12')).toContain('12-hour clock');
		expect(regionNote('YMD', 'h23')).toContain('year first');
	});
});

describe('clock times the code reads', () => {
	it('reads 24-hour and am/pm times, and never a dotted date', () => {
		expect(clockTimes('Dentist next Thursday at 4:30pm, then 18:05')).toEqual(['16:30', '18:05']);
		expect(clockTimes('pick up at 9 am or 12pm')).toEqual(['09:00', '12:00']);
		expect(clockTimes("saat 10:15'te, 3.11.2026 tarihinde, 1.5 kg")).toEqual(['10:15']);
		expect(clockTimes('25:00, 7:75, 13pm')).toEqual([]);
	});
});
