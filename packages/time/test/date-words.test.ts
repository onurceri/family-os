import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dateWords, isUncertainDate, weekdayMismatches } from '../src/index.ts';

/** The words of the English catalog and the bundled Turkish pack, read like the server does. */
function vocabulary(): (key: string) => readonly string[] {
	const root = join(import.meta.dirname, '../../..');
	const catalogs = [
		JSON.parse(readFileSync(join(root, 'apps/web/src/messages/en.json'), 'utf8')),
		JSON.parse(readFileSync(join(root, 'languages/tr/app.json'), 'utf8')),
	] as Record<string, string>[];
	return (key) => {
		const name = key.replace(/^app:/, '');
		const words = catalogs.flatMap((c) =>
			(c[name] ?? '').split(',').map((w) => w.trim().toLocaleLowerCase()),
		);
		return [...new Set(words.filter(Boolean))];
	};
}

const words = dateWords(vocabulary());
const TODAY = '2026-10-14'; // a Wednesday

describe('weekdayMismatches', () => {
	it('finds a weekday next to a date that falls on another day', () => {
		// 20 October 2026 is a Tuesday.
		expect(weekdayMismatches('Is there swimming on Wednesday 20 October?', TODAY, words)).toEqual([
			{ said: 'Wednesday 20 October', date: '2026-10-20', saidWeekday: 3, weekday: 2 },
		]);
	});

	it('reads the forms people write', () => {
		for (const text of [
			'wednesday, october 20',
			'Wed 20 Oct',
			'Wednesday 20th October',
			'Wednesday October 20, 2026',
			'Wednesday 2026-10-20',
			'Wednesday 20/10',
			'20 Ekim Çarşamba',
			'Çarşamba, 20 Ekim 2026 saat 18:00',
		])
			expect(weekdayMismatches(text, TODAY, words), text).toHaveLength(1);
	});

	it('says nothing when the weekday fits, or stands apart from the date', () => {
		for (const text of [
			'Is there swimming on Tuesday 20 October?',
			'Salı 20 Ekim',
			'On Wednesday, and also on 20 October',
			'Wednesday at 20:10',
			'the wedding on 20 October',
			'Wednesday',
			'20 October',
		])
			expect(weekdayMismatches(text, TODAY, words), text).toEqual([]);
	});

	it('reads an all-numeric date in the family order', () => {
		// 10/20 is 20 October month-first; 2026-10-20 is a Tuesday.
		expect(weekdayMismatches('Wednesday 10/20', TODAY, words, 'MDY')).toHaveLength(1);
		expect(weekdayMismatches('Tuesday 10/20', TODAY, words, 'MDY')).toEqual([]);
		// Day-first, 10/20 is no date at all.
		expect(weekdayMismatches('Wednesday 10/20', TODAY, words, 'DMY')).toEqual([]);
	});

	it('takes the year nearest to today when none is written', () => {
		// 5 January 2027 is a Tuesday (and 5 January 2026 a Monday).
		expect(weekdayMismatches('Monday 5 January', '2026-12-20', words)).toEqual([
			{ said: 'Monday 5 January', date: '2027-01-05', saidWeekday: 1, weekday: 2 },
		]);
		expect(weekdayMismatches('Monday 5 January 2026', '2026-12-20', words)).toEqual([]);
	});

	it('ignores dates that do not exist', () => {
		expect(weekdayMismatches('Monday 31 February', TODAY, words)).toEqual([]);
	});
});

describe('isUncertainDate', () => {
	it('reads the weekday and the day number of the quote', () => {
		expect(isUncertainDate('Friday the 9th', '2026-10-09', words)).toBe(false);
		expect(isUncertainDate('Thursday the 9th', '2026-10-09', words)).toBe(true);
		expect(isUncertainDate('next Thursday', '2026-10-15', words)).toBe(true);
		expect(isUncertainDate('tomorrow', '2026-10-15', words)).toBe(false);
	});
});
