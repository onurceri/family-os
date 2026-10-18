import { describe, expect, it } from 'vitest';
import {
	describeRecurrence,
	firstWeekday,
	lastDayOfMonth,
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
