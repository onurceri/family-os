import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	bareWeekdays,
	clockTimes,
	correctWeekdays,
	dateWords,
	isUncertainDate,
	weekdayMismatches,
} from '../src/index.ts';

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

describe('correctWeekdays', () => {
	/** A weekday's first catalog word in the language of the word it replaces (English or not). */
	const catalog = vocabulary();
	const english = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
	const name = ({ weekday }: { weekday: number }, said: string) =>
		english.includes(said.toLowerCase())
			? (english[weekday - 1] as string)
			: (catalog(`app:words_weekday_${weekday}`).find((w) => !english.includes(w)) ?? null);

	it('gives a date its real weekday, in the case it was written', () => {
		// 20 October 2026 is a Tuesday.
		const fixed = correctWeekdays(
			"The chore 'Take out the bins' is scheduled for Monday 20 October.",
			TODAY,
			words,
			'DMY',
			name,
		);
		expect(fixed.text).toBe("The chore 'Take out the bins' is scheduled for Tuesday 20 October.");
		expect(fixed.corrected).toEqual([
			{ said: 'Monday 20 October.', date: '2026-10-20', saidWeekday: 1, weekday: 2 },
		]);
		expect(correctWeekdays('MONDAY 20 OCTOBER', TODAY, words, 'DMY', name).text).toBe(
			'TUESDAY 20 OCTOBER',
		);
		expect(correctWeekdays('on monday, 20 october', TODAY, words, 'DMY', name).text).toBe(
			'on tuesday, 20 october',
		);
	});

	it('corrects several, and leaves the ones that fit', () => {
		expect(
			correctWeekdays(
				'Monday 19 October, Monday 20 October and Friday 23 October',
				TODAY,
				words,
				'DMY',
				name,
			).text,
		).toBe('Monday 19 October, Tuesday 20 October and Friday 23 October');
	});

	it('keeps a weekday that fits one of the dates next to it', () => {
		const text = 'From 19 October, Tuesday 20 October';
		expect(correctWeekdays(text, TODAY, words, 'DMY', name)).toEqual({ text, corrected: [] });
	});

	it('works in any language the catalogs hold', () => {
		expect(correctWeekdays('Pazartesi 20 Ekim', TODAY, words, 'DMY', name).text).toBe(
			'Salı 20 Ekim',
		);
	});

	it('leaves a weekday it has no word for', () => {
		const text = 'Monday 20 October';
		expect(correctWeekdays(text, TODAY, words, 'DMY', () => null)).toEqual({
			text,
			corrected: [],
		});
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

describe('bareWeekdays', () => {
	it('finds weekdays named without a date, once each', () => {
		expect(bareWeekdays('Remind me on Thursday at 18:30, and what is on Saturday?', words)).toEqual(
			[
				{ said: 'Thursday', weekday: 4 },
				{ said: 'Saturday', weekday: 6 },
			],
		);
		expect(bareWeekdays('thursday or Thursday?', words)).toEqual([
			{ said: 'thursday', weekday: 4 },
		]);
	});

	it('reads the names of every installed language, with their endings', () => {
		expect(bareWeekdays('Perşembe günü futbol çantamı hazırlamayı hatırlat', words)).toEqual([
			{ said: 'Perşembe', weekday: 4 },
		]);
	});

	it('leaves a text that writes a date to the other checks', () => {
		expect(bareWeekdays('Move only the Sunday planning on 25 October', words)).toEqual([]);
		expect(bareWeekdays('Is there swimming on Wednesday 20/10?', words)).toEqual([]);
	});

	it('does not read short names or times as weekdays', () => {
		expect(bareWeekdays('I sat down at 10:30 on the wed mat', words)).toEqual([]);
	});
});

describe('clockTimes', () => {
	it('reads times with minutes or a 12-hour mark as 24-hour times', () => {
		expect(clockTimes('Remind me on Thursday at 18:30')).toEqual(['18:30']);
		expect(clockTimes('at 6.30 pm, or 7am, or 12 a.m.')).toEqual(['18:30', '07:00', '00:00']);
	});

	it('leaves out bare hours, dates and impossible times', () => {
		expect(clockTimes('at 6 on 20.10.2026, 25:00 or 13pm')).toEqual([]);
	});
});
