import { describe, expect, it } from 'vitest';
import {
	describeRecurrence,
	firstRepeatDate,
	firstWeekday,
	followingDays,
	lastDayOfMonth,
	onlyThisDate,
	repeatEditAsks,
	repeatRule,
	weekdayOf,
	weekdaysAfterDateChange,
} from '../src/index.ts';

describe('lastDayOfMonth', () => {
	it('knows the length of each month, leap years included', () => {
		expect(lastDayOfMonth('2026-10-06')).toBe('2026-10-31');
		expect(lastDayOfMonth('2026-11-01')).toBe('2026-11-30');
		expect(lastDayOfMonth('2028-02-10')).toBe('2028-02-29');
		expect(lastDayOfMonth('2026-02-28')).toBe('2026-02-28');
	});
});

describe('firstWeekday', () => {
	it('moves forward to the first day the weekdays hold', () => {
		// 2026-10-06 is a Tuesday.
		expect(firstWeekday('2026-10-06', [3])).toBe('2026-10-07');
		expect(firstWeekday('2026-10-06', [2])).toBe('2026-10-06');
		expect(firstWeekday('2026-10-06', [1, 5])).toBe('2026-10-09');
	});
});

describe('repeatRule', () => {
	it('repeats weekly on the first date’s weekday when no weekday is given', () => {
		expect(repeatRule({ every: 'week' }, '2026-10-07')).toEqual({
			recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
			start: '2026-10-07',
			exact: true,
		});
	});

	it('starts a weekly series on one of its own days and ends it on the given day', () => {
		expect(repeatRule({ every: 'week', weekdays: [5, 3] }, '2026-10-06', '2026-10-31')).toEqual({
			recurrence: { freq: 'weekly', interval: 1, byDay: ['WE', 'FR'], until: '2026-10-31' },
			start: '2026-10-07',
			exact: true,
		});
	});

	it('ends a counted series on its last date', () => {
		const rule = repeatRule({ every: 'week', weekdays: [3], count: 4 }, '2026-10-07');
		expect(rule.recurrence).toEqual({
			freq: 'weekly',
			interval: 1,
			byDay: ['WE'],
			until: '2026-10-28',
		});
		expect(repeatRule({ every: 'day', interval: 2, count: 3 }, '2026-10-07').recurrence).toEqual({
			freq: 'daily',
			interval: 2,
			until: '2026-10-11',
		});
	});

	it('reads a yearly repeat as every 12 months, and cuts what the presets cannot hold', () => {
		expect(repeatRule({ every: 'year' }, '2026-10-07')).toEqual({
			recurrence: { freq: 'monthly', interval: 12 },
			start: '2026-10-07',
			exact: true,
		});
		expect(repeatRule({ every: 'year', interval: 2 }, '2026-10-07')).toEqual({
			recurrence: { freq: 'monthly', interval: 12 },
			start: '2026-10-07',
			exact: false,
		});
	});

	it('leaves out an end before the first date', () => {
		expect(repeatRule({ every: 'month' }, '2026-10-07', '2026-09-30')).toEqual({
			recurrence: { freq: 'monthly', interval: 1 },
			start: '2026-10-07',
			exact: false,
		});
	});
});

describe('describeRecurrence', () => {
	const t = (key: string, options?: Record<string, unknown>) =>
		key === 'repeat_weekly_on' ? `Every ${options?.day}` : key;
	const weekly = (byDay: ('MO' | 'TH' | 'SA')[], interval = 1) =>
		({ freq: 'weekly', interval, byDay }) as Parameters<typeof describeRecurrence>[0];

	it('names the weekday once when it is the start date’s own', () => {
		expect(describeRecurrence(weekly(['SA']), t, 'en', 1, '2026-10-17')).toBe('Every Saturday');
		expect(describeRecurrence(weekly(['SA']), t, 'tr', 1, '2026-10-17')).toBe('Every Cumartesi');
	});

	it('lists the days otherwise', () => {
		expect(describeRecurrence(weekly(['SA']), t, 'en', 1)).toBe('repeat_weekly · Sat');
		expect(describeRecurrence(weekly(['SA']), t, 'en', 1, '2026-10-22')).toBe(
			'repeat_weekly · Sat',
		);
		expect(describeRecurrence(weekly(['TH', 'SA']), t, 'en', 1, '2026-10-17')).toBe(
			'repeat_weekly · Thu, Sat',
		);
		expect(describeRecurrence(weekly(['SA'], 2), t, 'en', 1, '2026-10-17')).toBe(
			'repeat_weekly · Sat (×2)',
		);
	});
});

describe('weekdayOf', () => {
	it('names the weekday of a date', () => {
		expect(weekdayOf('2026-10-18')).toBe('SU');
		expect(weekdayOf('2026-10-20')).toBe('TU');
	});
});

describe('weekdaysAfterDateChange', () => {
	// 2026-10-18 is a Sunday, 2026-10-20 a Tuesday, 2026-10-22 a Thursday.
	it('moves a repeat that only held the old date weekday', () => {
		expect(weekdaysAfterDateChange(['SU'], '2026-10-18', '2026-10-20')).toEqual(['TU']);
		expect(weekdaysAfterDateChange([], '', '2026-10-20')).toEqual(['TU']);
	});

	it('follows a date changed twice', () => {
		let byDay = ['SU'];
		byDay = weekdaysAfterDateChange(byDay, '2026-10-18', '2026-10-22');
		byDay = weekdaysAfterDateChange(byDay, '2026-10-22', '2026-10-26');
		expect(byDay).toEqual(['MO']);
	});

	it('never drops chosen days: the new date weekday is added', () => {
		expect(weekdaysAfterDateChange(['TU', 'TH'], '2026-10-20', '2026-10-22')).toEqual(['TU', 'TH']);
		expect(weekdaysAfterDateChange(['TU', 'TH'], '2026-10-20', '2026-10-23')).toEqual([
			'TU',
			'TH',
			'FR',
		]);
		expect(weekdaysAfterDateChange(['MO'], '2026-10-17', '2026-10-22')).toEqual(['MO', 'TH']);
	});

	it('leaves the days alone while the date is not complete', () => {
		expect(weekdaysAfterDateChange(['SA'], '2026-10-17', '')).toEqual(['SA']);
		expect(weekdaysAfterDateChange(['SA'], '2026-10-17', '2026-10-2')).toEqual(['SA']);
	});
});

describe('a saved repeat keeps its days', () => {
	it('is not changed by a date change', () => {
		expect(weekdaysAfterDateChange(['TU'], '2026-10-18', '2026-10-21', true)).toEqual(['TU']);
		expect(weekdaysAfterDateChange([], '2026-10-18', '2026-10-21', true)).toEqual([]);
	});
	it('still follows the date for a new item', () => {
		expect(weekdaysAfterDateChange(['SU'], '2026-10-18', '2026-10-21')).toEqual(['WE']);
	});
});

describe('firstRepeatDate', () => {
	// 2026-10-18 is a Sunday.
	it('is the start date when it matches', () => {
		expect(firstRepeatDate('2026-10-18', ['SU'])).toBe('2026-10-18');
		expect(firstRepeatDate('2026-10-18', ['TU', 'SU'])).toBe('2026-10-18');
	});
	it('is the next matching day otherwise', () => {
		expect(firstRepeatDate('2026-10-21', ['TU'])).toBe('2026-10-27');
		expect(firstRepeatDate('2026-10-21', ['MO', 'FR'])).toBe('2026-10-23');
		expect(firstRepeatDate('2026-10-21', ['TU', 'TH'])).toBe('2026-10-22');
	});
	it('does not depend on the order of the days, so not on the week start', () => {
		// Monday-first and Sunday-first lists give the same date.
		expect(firstRepeatDate('2026-10-24', ['MO', 'SU'])).toBe('2026-10-25');
		expect(firstRepeatDate('2026-10-24', ['SU', 'MO'])).toBe('2026-10-25');
		expect(firstRepeatDate('2026-10-25', ['MO', 'SU'])).toBe('2026-10-25');
	});
	it('has nothing without days or a date', () => {
		expect(firstRepeatDate('2026-10-21', [])).toBeNull();
		expect(firstRepeatDate('', ['TU'])).toBeNull();
		expect(firstRepeatDate('2026-13-45', ['TU'])).toBeNull();
	});
});

describe('editing a saved repeat', () => {
	// 2026-10-18 is a Sunday, 2026-10-21 a Wednesday.
	const before = { repeat: 'weekly', date: '2026-10-18', byDay: ['TU'] };

	it('asks when the date moved or the weekly days changed', () => {
		expect(repeatEditAsks(before, { ...before, date: '2026-10-21' })).toBe(true);
		expect(repeatEditAsks(before, { ...before, byDay: ['TU', 'TH'] })).toBe(true);
		expect(repeatEditAsks(before, { ...before })).toBe(false);
	});

	it('asks nothing for what does not repeat before or after', () => {
		const moved = { ...before, date: '2026-10-21' };
		expect(repeatEditAsks({ ...before, repeat: 'none' }, moved)).toBe(false);
		expect(repeatEditAsks(before, { ...moved, repeat: 'none' })).toBe(false);
		expect(repeatEditAsks({ ...before, repeat: 'custom' }, moved)).toBe(false);
	});

	it('moves only this one to the typed date, or to the first of the new days', () => {
		expect(onlyThisDate(before, { ...before, date: '2026-10-21' }, '2026-10-18')).toBe(
			'2026-10-21',
		);
		const days = { ...before, byDay: ['FR'] };
		expect(onlyThisDate(before, days, '2026-10-18')).toBe('2026-10-23');
		expect(onlyThisDate(before, days, '2026-10-24')).toBe('2026-10-30');
	});

	it('moves a lone weekday of the old date, and keeps chosen days', () => {
		const lone = { repeat: 'weekly', date: '2026-10-18', byDay: ['SU'] };
		expect(followingDays(lone, { ...lone, date: '2026-10-21' })).toEqual(['WE']);
		expect(followingDays(before, { ...before, date: '2026-10-21' })).toEqual(['TU']);
		expect(followingDays(lone, { ...lone, date: '2026-10-21', byDay: ['SU', 'MO'] })).toEqual([
			'SU',
			'MO',
		]);
	});
});
