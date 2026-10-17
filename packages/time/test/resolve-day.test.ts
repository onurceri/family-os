import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DayParts, dateWords, type ResolveDayOptions, resolveDay } from '../src/index.ts';

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

type Row = [string, DayParts, Partial<ResolveDayOptions>, string, string | undefined, string?];

/**
 * Each row: what it shows, the parts, options beyond today, the date, the doubt (if any), and the
 * last day when it names a span.
 */
function table(rows: Row[]) {
	for (const [name, ref, options, date, why, to] of rows)
		it(name, () => {
			const result = resolveDay(ref, { today: TODAY, ...options });
			const span = to === undefined ? {} : { to };
			expect(result).toEqual(
				why === undefined
					? { date, certain: true, ...span }
					: { date, certain: false, why, ...span },
			);
		});
}

describe('resolveDay', () => {
	it('is null when nothing names a day', () => {
		expect(resolveDay(undefined, { today: TODAY })).toBeNull();
		expect(resolveDay({ text: 'soon' }, { today: TODAY })).toBeNull();
		expect(resolveDay({ text: 'soon', numeric: 'abc' }, { today: TODAY, words })).toBeNull();
		// Two numbers alone say nothing about which day.
		expect(resolveDay({ text: '3 or 4' }, { today: TODAY, words })).toBeNull();
	});

	it('reads a month the words alone name, as approximate', () => {
		expect(resolveDay({ text: 'Ekim sonuna kadar' }, { today: TODAY, words })).toEqual({
			date: TODAY,
			to: '2026-10-31',
			certain: false,
			why: 'approximate',
		});
		expect(
			resolveDay(
				{ text: 'until the end of December' },
				{ today: TODAY, words, direction: 'future' },
			),
		).toEqual({ date: '2026-12-01', to: '2026-12-31', certain: false, why: 'approximate' });
		// Two months say nothing about which one.
		expect(resolveDay({ text: 'October or November' }, { today: TODAY, words })).toBeNull();
	});

	describe('counted days', () => {
		table([
			['today', { inDays: 0 }, {}, '2026-10-14', undefined],
			['tomorrow', { inDays: 1 }, {}, '2026-10-15', undefined],
			['yesterday', { inDays: -1 }, {}, '2026-10-13', undefined],
			['in two weeks is loose', { inDays: 14 }, {}, '2026-10-28', 'relative'],
			['three days ago is loose', { inDays: -3 }, {}, '2026-10-11', 'relative'],
		]);
	});

	describe('a day and a month', () => {
		table([
			['with a year', { day: 3, month: 2, year: 2027 }, {}, '2027-02-03', undefined],
			['coming, this year', { day: 20, month: 10 }, {}, '2026-10-20', undefined],
			['coming, next year', { day: 15, month: 3 }, {}, '2027-03-15', undefined],
			[
				'coming but far: the year is a guess',
				{ day: 1, month: 5 },
				{},
				'2027-05-01',
				'guessed_year',
			],
			['done: the last one', { day: 1, month: 5 }, { direction: 'past' }, '2026-05-01', undefined],
			[
				'yesterday as a plan is a year away',
				{ day: 13, month: 10 },
				{},
				'2027-10-13',
				'guessed_year',
			],
			['yesterday as done', { day: 13, month: 10 }, { direction: 'past' }, '2026-10-13', undefined],
			['today either way', { day: 14, month: 10 }, { direction: 'past' }, '2026-10-14', undefined],
			[
				'nearest picks the closer year',
				{ day: 1, month: 5 },
				{ direction: 'nearest' },
				'2026-05-01',
				undefined,
			],
			['29 February finds its leap year', { day: 29, month: 2 }, {}, '2028-02-29', 'guessed_year'],
			['a weekday that fits', { day: 20, month: 10, weekday: 2 }, {}, '2026-10-20', undefined],
			[
				'a weekday that does not fit: the day wins',
				{ day: 20, month: 10, weekday: 3 },
				{},
				'2026-10-20',
				'mismatch',
			],
			[
				'a count that does not fit',
				{ day: 20, month: 10, inDays: 1 },
				{},
				'2026-10-20',
				'mismatch',
			],
		]);
		it('falls back to the month, as a guess, for a day the month does not have', () => {
			expect(resolveDay({ day: 31, month: 11, year: 2026 }, { today: TODAY })).toEqual({
				date: '2026-11-01',
				to: '2026-11-30',
				certain: false,
				why: 'approximate',
			});
		});
	});

	describe('a day number alone', () => {
		table([
			['later this month', { day: 20 }, {}, '2026-10-20', undefined],
			['passed this month: next month', { day: 10 }, {}, '2026-11-10', undefined],
			['done: this month', { day: 10 }, { direction: 'past' }, '2026-10-10', undefined],
			[
				'done, not yet this month: last month',
				{ day: 20 },
				{ direction: 'past' },
				'2026-09-20',
				undefined,
			],
			['the 31st this month', { day: 31 }, {}, '2026-10-31', undefined],
			[
				'the 31st done skips September',
				{ day: 31 },
				{ direction: 'past' },
				'2026-08-31',
				undefined,
			],
			['nearest', { day: 10 }, { direction: 'nearest' }, '2026-10-10', undefined],
		]);
	});

	describe('an all-numeric date in the family order', () => {
		table([
			['day first', { numeric: '03/04' }, { order: 'DMY' }, '2027-04-03', undefined],
			['month first', { numeric: '03/04' }, { order: 'MDY' }, '2027-03-04', undefined],
			[
				'year first: a bare pair is month-day',
				{ numeric: '03/04' },
				{ order: 'YMD' },
				'2027-03-04',
				undefined,
			],
			['ISO in any order', { numeric: '2026-10-20' }, { order: 'MDY' }, '2026-10-20', undefined],
			[
				'ISO in day-first order',
				{ numeric: '2026-10-20' },
				{ order: 'DMY' },
				'2026-10-20',
				undefined,
			],
			['dots and a short year', { numeric: '20.10.26' }, { order: 'DMY' }, '2026-10-20', undefined],
			['a trailing dot', { numeric: '3.11.' }, { order: 'DMY' }, '2026-11-03', undefined],
			[
				'month first with a year',
				{ numeric: '10/20/2026' },
				{ order: 'MDY' },
				'2026-10-20',
				undefined,
			],
			[
				'year first with slashes',
				{ numeric: '2026/10/20' },
				{ order: 'YMD' },
				'2026-10-20',
				undefined,
			],
			[
				'written the other way round',
				{ numeric: '10/20' },
				{ order: 'DMY' },
				'2026-10-20',
				'mismatch',
			],
			[
				'wins over parts read in another order',
				{ numeric: '03/04', day: 4, month: 3 },
				{ order: 'DMY' },
				'2027-04-03',
				'mismatch',
			],
			[
				'agrees with its parts',
				{ numeric: '03/04', day: 3, month: 4 },
				{ order: 'DMY' },
				'2027-04-03',
				undefined,
			],
		]);
	});

	describe('a weekday', () => {
		table([
			['the coming one', { weekday: 4 }, {}, '2026-10-15', 'weekday_only'],
			['the coming Monday', { weekday: 1 }, {}, '2026-10-19', 'weekday_only'],
			["today's, no time given", { weekday: 3 }, {}, '2026-10-14', 'weekday_only'],
			[
				"today's, time ahead",
				{ weekday: 3 },
				{ time: '20:00', now: '19:00' },
				'2026-10-14',
				'weekday_only',
			],
			[
				"today's, time passed",
				{ weekday: 3 },
				{ time: '18:30', now: '19:00' },
				'2026-10-21',
				'weekday_only',
			],
			[
				"today's, at this minute",
				{ weekday: 3 },
				{ time: '19:00', now: '19:00' },
				'2026-10-21',
				'weekday_only',
			],
			['done: the last one', { weekday: 1 }, { direction: 'past' }, '2026-10-12', 'weekday_only'],
			[
				'done: the last Thursday',
				{ weekday: 4 },
				{ direction: 'past' },
				'2026-10-08',
				'weekday_only',
			],
			[
				'done today, time passed',
				{ weekday: 3 },
				{ direction: 'past', time: '08:00', now: '19:00' },
				'2026-10-14',
				'weekday_only',
			],
			[
				'done today, time ahead: last week',
				{ weekday: 3 },
				{ direction: 'past', time: '20:00', now: '19:00' },
				'2026-10-07',
				'weekday_only',
			],
			['nearest: tomorrow', { weekday: 4 }, { direction: 'nearest' }, '2026-10-15', 'weekday_only'],
			[
				'nearest: two days ago',
				{ weekday: 1 },
				{ direction: 'nearest' },
				'2026-10-12',
				'weekday_only',
			],
		]);
	});

	describe('a weekday in a named week', () => {
		table([
			[
				'next week, weeks from Monday',
				{ weekday: 4, week: 'next' },
				{ weekStart: 1 },
				'2026-10-22',
				'weekday_only',
			],
			['this week', { weekday: 5, week: 'this' }, { weekStart: 1 }, '2026-10-16', 'weekday_only'],
			[
				'this week, already passed, as a plan',
				{ weekday: 1, week: 'this' },
				{ weekStart: 1 },
				'2026-10-19',
				'weekday_only',
			],
			[
				'this week, already passed, done',
				{ weekday: 1, week: 'this' },
				{ weekStart: 1, direction: 'past' },
				'2026-10-12',
				'weekday_only',
			],
			[
				'the week after next',
				{ weekday: 1, week: 'after_next' },
				{ weekStart: 1 },
				'2026-10-26',
				'weekday_only',
			],
			[
				'next Sunday, weeks from Monday',
				{ weekday: 7, week: 'next' },
				{ weekStart: 1 },
				'2026-10-25',
				'weekday_only',
			],
			[
				'next Sunday, weeks from Sunday',
				{ weekday: 7, week: 'next' },
				{ weekStart: 7 },
				'2026-10-18',
				'weekday_only',
			],
			[
				'this Sunday, weeks from Monday',
				{ weekday: 7, week: 'this' },
				{ weekStart: 1 },
				'2026-10-18',
				'weekday_only',
			],
			[
				'this Saturday, weeks from Saturday',
				{ weekday: 6, week: 'this' },
				{ weekStart: 6 },
				'2026-10-17',
				'weekday_only',
			],
			[
				'next Friday, weeks from Saturday',
				{ weekday: 5, week: 'next' },
				{ weekStart: 6 },
				'2026-10-23',
				'weekday_only',
			],
		]);
	});

	describe('a month or a span', () => {
		table([
			[
				'early next month',
				{ month: 11, approximate: true },
				{},
				'2026-11-01',
				'approximate',
				'2026-11-30',
			],
			['a month alone is a span', { month: 11 }, {}, '2026-11-01', 'approximate', '2026-11-30'],
			[
				'this month, from today',
				{ month: 10, approximate: true },
				{},
				'2026-10-14',
				'approximate',
				'2026-10-31',
			],
			[
				'a past month, done',
				{ month: 3 },
				{ direction: 'past' },
				'2026-03-01',
				'approximate',
				'2026-03-31',
			],
			[
				'a month with a year',
				{ month: 1, year: 2027 },
				{},
				'2027-01-01',
				'approximate',
				'2027-01-31',
			],
			// Found in use: "cancelled this week" named no day, so the whole calendar was searched.
			[
				'this week, from today',
				{ text: 'this week', week: 'this' },
				{},
				'2026-10-14',
				'approximate',
				'2026-10-18',
			],
			[
				'next week, from its first day',
				{ text: 'next week', week: 'next' },
				{},
				'2026-10-19',
				'approximate',
				'2026-10-25',
			],
			[
				'this week, by the family week',
				{ text: 'this week', week: 'this' },
				{ weekStart: 7 },
				'2026-10-14',
				'approximate',
				'2026-10-17',
			],
			[
				'this week, for something done',
				{ text: 'this week', week: 'this' },
				{ direction: 'past' },
				'2026-10-12',
				'approximate',
				'2026-10-14',
			],
			[
				'a day marked vague',
				{ day: 31, month: 10, approximate: true },
				{},
				'2026-10-31',
				'approximate',
			],
		]);
	});

	describe("checked against the model's own quoted words", () => {
		table([
			[
				'a weekday the date does not fall on',
				{ text: 'Wednesday 20 October', day: 20, month: 10 },
				{ words },
				'2026-10-20',
				'mismatch',
			],
			[
				'a fitting weekday',
				{ text: 'Tuesday 20 October', day: 20, month: 10, weekday: 2 },
				{ words },
				'2026-10-20',
				undefined,
			],
			[
				'a misread weekday: the words win',
				{ text: 'on Thursday', weekday: 5 },
				{ words },
				'2026-10-15',
				'mismatch',
			],
			[
				'a misread day number: the words win',
				{ text: '20 Ekim', day: 21, month: 10 },
				{ words },
				'2026-10-20',
				'mismatch',
			],
			[
				'month words of another language',
				{ text: '15 Ekim', day: 15, month: 10 },
				{ words },
				'2026-10-15',
				undefined,
			],
			['words with no parts', { text: '20 Ekim' }, { words }, '2026-10-20', undefined],
			// Found in use: a model quoted "next Thursday" and gave no parts.
			[
				'a weekday in the words only, with no parts',
				{ text: 'next Thursday' },
				{ words },
				'2026-10-15',
				'weekday_only',
			],
			// Found in use: "Yarın" quoted with no parts.
			['tomorrow in the words only', { text: 'Yarın' }, { words }, '2026-10-15', undefined],
			// Found in use: "Thu 15" read as a weekday alone became the coming Thursday, the 8th.
			[
				'a weekday with a day number its words write and the model left out',
				{ text: 'Thu 22', weekday: 4 },
				{ words },
				'2026-10-22',
				undefined,
			],
			[
				'a number that is not that weekday is no day',
				{ text: 'Thursday at 4', weekday: 4 },
				{ words },
				'2026-10-15',
				'weekday_only',
			],
			// Found in use: "yarın" read with today's day number became today.
			[
				'tomorrow in the words wins over a day number they do not write',
				{ text: 'yarın', day: 14, month: 10 },
				{ words },
				'2026-10-15',
				undefined,
			],
			[
				'tomorrow in the words wins over a count of today',
				{ text: 'tomorrow', inDays: 0 },
				{ words },
				'2026-10-15',
				undefined,
			],
			[
				'the day after tomorrow keeps its count',
				{ text: 'the day after tomorrow', inDays: 2 },
				{ words },
				'2026-10-16',
				'relative',
			],
			[
				'a date written in digits wins over the word',
				{ text: 'tomorrow, 20 October', day: 20, month: 10 },
				{ words },
				'2026-10-20',
				undefined,
			],
			['yesterday in the words only', { text: 'yesterday' }, { words }, '2026-10-13', undefined],
			// Found in use: "ayın 15'i" quoted with no parts.
			[
				'one number alone in the words: the day of the month, to check',
				{ text: "ayın 15'i" },
				{ words },
				'2026-10-15',
				'approximate',
			],
			[
				'a weekday in another language',
				{ text: 'Perşembe', weekday: 4 },
				{ words },
				'2026-10-15',
				'weekday_only',
			],
			[
				'a numeric date in the family order',
				{ text: '03/04', day: 4, month: 3 },
				{ words, order: 'DMY' },
				'2027-04-03',
				'mismatch',
			],
			[
				'the same numeric date in month-first order',
				{ text: '03/04', day: 4, month: 3 },
				{ words, order: 'MDY' },
				'2027-03-04',
				undefined,
			],
			[
				'a clock time is not a date',
				{ text: 'Thursday saat 16.30', weekday: 4 },
				{ words },
				'2026-10-15',
				'weekday_only',
			],
			[
				'a count with a weekday that does not fit',
				{ text: 'tomorrow, Friday', inDays: 1 },
				{ words },
				'2026-10-15',
				'mismatch',
			],
			[
				'a count with no weekday',
				{ text: 'tomorrow', inDays: 1 },
				{ words },
				'2026-10-15',
				undefined,
			],
		]);
		it('are not read without the words', () => {
			expect(
				resolveDay({ text: 'Wednesday 20 October', day: 20, month: 10 }, { today: TODAY }),
			).toEqual({ date: '2026-10-20', certain: true });
		});
	});
});
