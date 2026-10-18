import { describe, expect, it } from 'vitest';
import { resolveSpan, type SpanInput, type SpanLabelKey } from '../src/index.ts';

// 2026-10-12 is a Monday.
const MONDAY = 1;
const SUNDAY = 7;

type Row = [string, SpanInput, string, number, string, string, SpanLabelKey];

const ROWS: Row[] = [
	// This week, weeks starting on Monday (the week's last day is Sunday 18).
	[
		'week, midweek',
		{ kind: 'week' },
		'2026-10-14',
		MONDAY,
		'2026-10-14',
		'2026-10-18',
		'this_week',
	],
	[
		'week, first day',
		{ kind: 'week' },
		'2026-10-12',
		MONDAY,
		'2026-10-12',
		'2026-10-18',
		'this_week',
	],
	[
		'week, day before the last',
		{ kind: 'week' },
		'2026-10-17',
		MONDAY,
		'2026-10-17',
		'2026-10-18',
		'this_week',
	],
	[
		'week, last day: the coming seven days',
		{ kind: 'week' },
		'2026-10-18',
		MONDAY,
		'2026-10-18',
		'2026-10-24',
		'coming_days',
	],
	// Weeks starting on Sunday (the week's last day is Saturday 17).
	[
		'week, midweek, Sunday start',
		{ kind: 'week' },
		'2026-10-14',
		SUNDAY,
		'2026-10-14',
		'2026-10-17',
		'this_week',
	],
	[
		'week, first day, Sunday start',
		{ kind: 'week' },
		'2026-10-18',
		SUNDAY,
		'2026-10-18',
		'2026-10-24',
		'this_week',
	],
	[
		'week, last day, Sunday start',
		{ kind: 'week' },
		'2026-10-17',
		SUNDAY,
		'2026-10-17',
		'2026-10-23',
		'coming_days',
	],
	[
		'week, a Sunday that is not the last day',
		{ kind: 'week' },
		'2026-10-11',
		SUNDAY,
		'2026-10-11',
		'2026-10-17',
		'this_week',
	],
	// Next week is the one after, whole, on every day.
	[
		'next, midweek',
		{ kind: 'next' },
		'2026-10-14',
		MONDAY,
		'2026-10-19',
		'2026-10-25',
		'next_week',
	],
	[
		'next, last day',
		{ kind: 'next' },
		'2026-10-18',
		MONDAY,
		'2026-10-19',
		'2026-10-25',
		'next_week',
	],
	[
		'next, Sunday start',
		{ kind: 'next' },
		'2026-10-14',
		SUNDAY,
		'2026-10-18',
		'2026-10-24',
		'next_week',
	],
	[
		'next, last day, Sunday start',
		{ kind: 'next' },
		'2026-10-17',
		SUNDAY,
		'2026-10-18',
		'2026-10-24',
		'next_week',
	],
	[
		'week named next',
		{ kind: 'week', day: { text: 'next week', week: 'next' } },
		'2026-10-14',
		MONDAY,
		'2026-10-19',
		'2026-10-25',
		'next_week',
	],
	[
		'week named after next',
		{ kind: 'week', day: { text: 'x', week: 'after_next' } },
		'2026-10-14',
		MONDAY,
		'2026-10-26',
		'2026-11-01',
		'next_week',
	],
	[
		'a week named only by the day reference',
		{ day: { text: 'next week', week: 'next' } },
		'2026-10-14',
		SUNDAY,
		'2026-10-18',
		'2026-10-24',
		'next_week',
	],
	[
		'"this week" in the day reference on the last day',
		{ day: { text: 'this week', week: 'this' } },
		'2026-10-18',
		MONDAY,
		'2026-10-18',
		'2026-10-24',
		'coming_days',
	],
	// The weekend.
	[
		'weekend, midweek',
		{ kind: 'weekend' },
		'2026-10-14',
		MONDAY,
		'2026-10-17',
		'2026-10-18',
		'weekend',
	],
	[
		'weekend, Monday',
		{ kind: 'weekend' },
		'2026-10-12',
		MONDAY,
		'2026-10-17',
		'2026-10-18',
		'weekend',
	],
	[
		'weekend, Friday',
		{ kind: 'weekend' },
		'2026-10-16',
		MONDAY,
		'2026-10-17',
		'2026-10-18',
		'weekend',
	],
	[
		'weekend, Saturday: from today',
		{ kind: 'weekend' },
		'2026-10-17',
		MONDAY,
		'2026-10-17',
		'2026-10-18',
		'weekend',
	],
	[
		'weekend, Sunday: today',
		{ kind: 'weekend' },
		'2026-10-18',
		MONDAY,
		'2026-10-18',
		'2026-10-18',
		'weekend',
	],
	[
		'weekend, Sunday, Sunday start',
		{ kind: 'weekend' },
		'2026-10-18',
		SUNDAY,
		'2026-10-18',
		'2026-10-18',
		'weekend',
	],
	[
		'weekend, Wednesday, Sunday start',
		{ kind: 'weekend' },
		'2026-10-14',
		SUNDAY,
		'2026-10-17',
		'2026-10-18',
		'weekend',
	],
	// A month.
	['this month', { kind: 'month' }, '2026-10-14', MONDAY, '2026-10-14', '2026-10-31', 'month'],
	[
		'this month, on its last day',
		{ kind: 'month' },
		'2026-10-31',
		SUNDAY,
		'2026-10-31',
		'2026-10-31',
		'month',
	],
	[
		'this month, February of a leap year',
		{ kind: 'month' },
		'2028-02-10',
		MONDAY,
		'2028-02-10',
		'2028-02-29',
		'month',
	],
	[
		'a month named',
		{ kind: 'month', day: { text: 'November', month: 11 } },
		'2026-10-14',
		MONDAY,
		'2026-11-01',
		'2026-11-30',
		'month',
	],
	[
		'a month named that has passed is next year’s',
		{ kind: 'month', day: { text: 'March', month: 3 } },
		'2026-10-14',
		MONDAY,
		'2027-03-01',
		'2027-03-31',
		'month',
	],
	// Until a day, a range, a day.
	[
		'until Friday',
		{ to: { text: 'until Friday', weekday: 5 } },
		'2026-10-14',
		MONDAY,
		'2026-10-14',
		'2026-10-16',
		'until',
	],
	[
		'until Friday, asked on Friday',
		{ to: { text: 'until Friday', weekday: 5 } },
		'2026-10-16',
		MONDAY,
		'2026-10-16',
		'2026-10-16',
		'until',
	],
	[
		'until a date',
		{ to: { text: '25 October', day: 25, month: 10 } },
		'2026-10-14',
		SUNDAY,
		'2026-10-14',
		'2026-10-25',
		'until',
	],
	[
		'from a day to a day',
		{ from: { text: 'a', day: 20, month: 10 }, to: { text: 'b', day: 23, month: 10 } },
		'2026-10-14',
		MONDAY,
		'2026-10-20',
		'2026-10-23',
		'range',
	],
	[
		'a range given the other way round',
		{ from: { text: 'a', day: 23, month: 10 }, to: { text: 'b', day: 20, month: 10 } },
		'2026-10-14',
		MONDAY,
		'2026-10-20',
		'2026-10-23',
		'range',
	],
	[
		'a day',
		{ kind: 'day', day: { text: 'tomorrow', inDays: 1 } },
		'2026-10-14',
		MONDAY,
		'2026-10-15',
		'2026-10-15',
		'day',
	],
	[
		'today',
		{ kind: 'day', day: { text: 'today', inDays: 0 } },
		'2026-10-14',
		MONDAY,
		'2026-10-14',
		'2026-10-14',
		'today',
	],
	[
		'a bare weekday is the coming one',
		{ day: { text: 'Thursday', weekday: 4 } },
		'2026-10-14',
		SUNDAY,
		'2026-10-15',
		'2026-10-15',
		'day',
	],
];

describe('resolveSpan', () => {
	it.each(ROWS)('%s', (_name, span, today, weekStart, from, to, key) => {
		expect(resolveSpan(span, today, weekStart)).toEqual({
			from,
			to,
			label: { key, from, to },
		});
	});

	it('takes the weekend days a region sets', () => {
		// A Friday and Saturday weekend: Wednesday 14 looks ahead to Friday 16.
		const options = { weekend: [5, 6] } as const;
		expect(resolveSpan({ kind: 'weekend' }, '2026-10-14', MONDAY, options)).toMatchObject({
			from: '2026-10-16',
			to: '2026-10-17',
		});
		expect(resolveSpan({ kind: 'weekend' }, '2026-10-17', MONDAY, options)).toMatchObject({
			from: '2026-10-17',
			to: '2026-10-17',
		});
		expect(resolveSpan({ kind: 'weekend' }, '2026-10-18', MONDAY, options)).toMatchObject({
			from: '2026-10-23',
			to: '2026-10-24',
		});
	});

	it('is null when nothing names a stretch', () => {
		expect(resolveSpan({}, '2026-10-14', MONDAY)).toBeNull();
		expect(resolveSpan({ kind: 'day' }, '2026-10-14', MONDAY)).toBeNull();
		expect(resolveSpan({ to: {} }, '2026-10-14', MONDAY)).toBeNull();
	});

	it('does not read an end that has passed as "until"', () => {
		expect(
			resolveSpan({ to: { text: 'x', day: 1, month: 10, year: 2026 } }, '2026-10-14', MONDAY),
		).toBeNull();
	});
});
