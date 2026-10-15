import { describe, expect, it } from 'vitest';
import {
	addDays,
	dateLocale,
	dayBounds,
	daysAround,
	defaultHourCycle,
	defaultTemperatureUnit,
	defaultWeekStart,
	epochOf,
	everyFromRule,
	everyToRule,
	expandDates,
	expandTimed,
	formatClock,
	fromRRule,
	isFormatLocale,
	isValidDate,
	nextDate,
	nextEveryDue,
	numericDateOrder,
	orderedWeekdays,
	type Recurrence,
	regionFormats,
	setupFormatLocale,
	todayIn,
	toRRule,
	weekOf,
	zoned,
} from '../src/index.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('dates and zones', () => {
	it('validates dates strictly', () => {
		expect(isValidDate('2026-02-28')).toBe(true);
		expect(isValidDate('2026-02-30')).toBe(false);
		expect(isValidDate('26-2-3')).toBe(false);
	});

	it('knows today per zone', () => {
		const lateUtc = Date.UTC(2026, 9, 6, 22, 30); // 22:30 UTC = 01:30 next day in Istanbul
		expect(todayIn('UTC', lateUtc)).toBe('2026-10-06');
		expect(todayIn('Europe/Istanbul', lateUtc)).toBe('2026-10-07');
	});

	it('handles DST-length days', () => {
		const autumn = dayBounds('2026-10-25', 'Europe/Berlin');
		expect(autumn.end - autumn.start).toBe(25 * HOUR);
		const spring = dayBounds('2026-03-29', 'Europe/Berlin');
		expect(spring.end - spring.start).toBe(23 * HOUR);
	});

	it('converts local times to instants', () => {
		expect(epochOf('2026-10-06', '09:00', 'Europe/Istanbul')).toBe(Date.UTC(2026, 9, 6, 6, 0));
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
	});
});

describe('recurrence presets', () => {
	const cases: [Recurrence, string][] = [
		[{ freq: 'daily', interval: 1 }, 'FREQ=DAILY'],
		[{ freq: 'weekly', interval: 2, byDay: ['MO', 'WE'] }, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'],
		[{ freq: 'monthly', interval: 1, until: '2026-12-31' }, 'FREQ=MONTHLY;UNTIL=20261231T205959Z'],
	];

	it.each(cases)('round-trips %j', (preset, rrule) => {
		expect(toRRule(preset, 'Europe/Istanbul')).toBe(rrule);
		expect(fromRRule(rrule, 'Europe/Istanbul')).toEqual(preset);
	});

	it('writes weekdays in calendar order', () => {
		expect(toRRule({ freq: 'weekly', interval: 1, byDay: ['SU', 'WE', 'MO'] }, 'UTC')).toBe(
			'FREQ=WEEKLY;BYDAY=MO,WE,SU',
		);
	});

	it('returns null for rules outside the presets', () => {
		expect(fromRRule('FREQ=YEARLY', 'UTC')).toBeNull();
		expect(fromRRule('FREQ=MONTHLY;BYDAY=2TU', 'UTC')).toBeNull();
		expect(fromRRule('FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO', 'UTC')).toBeNull();
	});
});

describe('expansion', () => {
	it('keeps local wall time across a DST change', () => {
		const start = epochOf('2026-10-19', '09:00', 'Europe/Berlin'); // Monday before DST ends
		const series = { startsAt: start, timeZone: 'Europe/Berlin', rrule: 'FREQ=WEEKLY;BYDAY=MO' };
		const [first, second, third] = expandTimed(series, start, start + 15 * DAY);
		expect(first).toBe(start);
		expect(Number(second) - Number(first)).toBe(7 * DAY + HOUR);
		expect(zoned(Number(third), 'Europe/Berlin').toPlainTime().toString()).toBe('09:00:00');
	});

	it('expands within a window and honours exdates and until', () => {
		const start = epochOf('2026-10-05', '17:30', 'Europe/Istanbul');
		const series = {
			startsAt: start,
			timeZone: 'Europe/Istanbul',
			rrule: toRRule(
				{ freq: 'weekly', interval: 1, byDay: ['MO', 'TH'], until: '2026-10-22' },
				'Europe/Istanbul',
			),
			exdates: [epochOf('2026-10-08', '17:30', 'Europe/Istanbul')],
		};
		const days = expandTimed(series, start, start + 60 * DAY).map((ms) =>
			zoned(ms, 'Europe/Istanbul').toPlainDate().toString(),
		);
		expect(days).toEqual(['2026-10-05', '2026-10-12', '2026-10-15', '2026-10-19', '2026-10-22']);
	});

	it('returns a single event only when it falls inside the window', () => {
		const at = Date.UTC(2026, 9, 6, 9);
		expect(expandTimed({ startsAt: at, timeZone: 'UTC', rrule: null }, at, at + 1)).toEqual([at]);
		expect(expandTimed({ startsAt: at, timeZone: 'UTC', rrule: null }, at + 1, at + DAY)).toEqual(
			[],
		);
	});

	it('ends date series on their last day in every time zone', () => {
		const rrule = toRRule({ freq: 'daily', interval: 1, until: '2026-10-10' }, null);
		expect(rrule).toBe('FREQ=DAILY;UNTIL=20261010');
		expect(expandDates({ date: '2026-10-08', rrule }, '2026-10-01', '2026-10-31')).toEqual([
			'2026-10-08',
			'2026-10-09',
			'2026-10-10',
		]);
		expect(fromRRule(rrule, 'America/New_York')).toEqual({
			freq: 'daily',
			interval: 1,
			until: '2026-10-10',
		});
	});

	it('expands all-day series without zone drift', () => {
		const series = { date: '2026-01-31', rrule: 'FREQ=MONTHLY' };
		expect(expandDates(series, '2026-01-01', '2026-05-31')).toEqual([
			'2026-01-31',
			'2026-03-31',
			'2026-05-31',
		]);
		expect(expandDates({ date: '2026-10-10', rrule: null }, '2026-10-01', '2026-10-31')).toEqual([
			'2026-10-10',
		]);
	});

	it('finds the next occurrence for recurring tasks', () => {
		const trash = { date: '2026-10-05', rrule: 'FREQ=WEEKLY;BYDAY=MO' };
		expect(nextDate(trash, '2026-10-05')).toBe('2026-10-12');
		expect(nextDate(trash, '2026-10-07')).toBe('2026-10-12');
		expect(nextDate({ date: '2026-10-05', rrule: null }, '2026-10-05')).toBeNull();
	});
});

describe('region formats', () => {
	// 8 October 2026 is a Thursday.
	it('starts the week on the chosen day (Monday, Saturday, Sunday)', () => {
		expect(weekOf('2026-10-08')[0]).toBe('2026-10-05');
		expect(weekOf('2026-10-08', 1)).toEqual([
			'2026-10-05',
			'2026-10-06',
			'2026-10-07',
			'2026-10-08',
			'2026-10-09',
			'2026-10-10',
			'2026-10-11',
		]);
		expect(weekOf('2026-10-08', 7)[0]).toBe('2026-10-04');
		expect(weekOf('2026-10-08', 7)[6]).toBe('2026-10-10');
		expect(weekOf('2026-10-08', 6)[0]).toBe('2026-10-03');
		expect(weekOf('2026-10-08', 6)[6]).toBe('2026-10-09');
		// The first day itself and the day before it fall in different weeks.
		expect(weekOf('2026-10-04', 7)[0]).toBe('2026-10-04');
		expect(weekOf('2026-10-03', 7)[0]).toBe('2026-09-27');
	});

	it('orders the repeat-picker weekdays from the first day', () => {
		expect(orderedWeekdays()).toEqual(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
		expect(orderedWeekdays(7)).toEqual(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
		expect(orderedWeekdays(6)).toEqual(['SA', 'SU', 'MO', 'TU', 'WE', 'TH', 'FR']);
	});

	it('derives week start, clock, temperature and date order from the region', () => {
		expect(defaultWeekStart('en-US')).toBe(7);
		expect(defaultWeekStart('en-GB')).toBe(1);
		expect(defaultWeekStart('de-DE')).toBe(1);
		expect(defaultHourCycle('en-US')).toBe('h12');
		expect(defaultHourCycle('en-GB')).toBe('h23');
		expect(defaultHourCycle('tr-TR')).toBe('h23');
		expect(defaultTemperatureUnit('en-US')).toBe('fahrenheit');
		expect(defaultTemperatureUnit('en-GB')).toBe('celsius');
		expect(defaultTemperatureUnit('tr-TR')).toBe('celsius');
		expect(numericDateOrder('en-US')).toBe('MDY');
		expect(numericDateOrder('en-GB')).toBe('DMY');
		expect(numericDateOrder('de-DE')).toBe('DMY');
		expect(numericDateOrder('ja-JP')).toBe('YMD');
	});

	it('validates BCP 47 tags', () => {
		expect(isFormatLocale('en-GB')).toBe(true);
		expect(isFormatLocale('en_GB')).toBe(false);
		expect(isFormatLocale('')).toBe(false);
	});

	it('writes clock times in the family hour cycle', () => {
		const norm = (v: string) => v.replace(/[\u202f\u00a0]/g, ' ');
		expect(formatClock('14:30', 'en-GB', 'h23')).toBe('14:30');
		expect(norm(formatClock('14:30', 'en-US', 'h12'))).toBe('2:30 PM');
		expect(formatClock('not a time', 'en-US', 'h12')).toBe('not a time');
	});
});

describe('every N months or years', () => {
	it('stores an RFC 5545 rule and reads it back', () => {
		expect(everyToRule({ months: 3 })).toBe('FREQ=MONTHLY;INTERVAL=3');
		expect(everyToRule({ years: 1 })).toBe('FREQ=YEARLY;INTERVAL=1');
		expect(everyFromRule('FREQ=MONTHLY;INTERVAL=6')).toEqual({ months: 6 });
		expect(everyFromRule('FREQ=YEARLY;INTERVAL=2')).toEqual({ years: 2 });
		expect(everyFromRule('FREQ=WEEKLY;BYDAY=MO')).toBeNull();
		expect(everyFromRule(null)).toBeNull();
	});

	it('counts from the anchor and keeps the last day of short months', () => {
		expect(nextEveryDue('2026-01-31', { months: 1 }, '2026-01-31')).toBe('2026-02-28');
		expect(nextEveryDue('2026-01-31', { months: 1 }, '2026-02-28')).toBe('2026-03-31');
		expect(nextEveryDue('2028-02-29', { years: 1 }, '2028-02-29')).toBe('2029-02-28');
		expect(nextEveryDue('2028-02-29', { years: 1 }, '2031-02-28')).toBe('2032-02-29');
	});
});

describe('setupFormatLocale', () => {
	it("starts from the browser's own region format, whatever the language", () => {
		expect(setupFormatLocale('tr', 'tr-TR')).toBe('tr-TR');
		expect(setupFormatLocale('en', 'en-GB')).toBe('en-GB');
		expect(setupFormatLocale('tr', 'en-US')).toBe('en-US');
		expect(setupFormatLocale('de', 'en-NL')).toBe('en-NL');
	});
	it("falls back to the language's own region when the browser has none", () => {
		expect(setupFormatLocale('tr', 'en')).toBe('tr-TR');
	});
});

describe('dateLocale', () => {
	const thursday = Date.UTC(2026, 9, 22, 17, 5);
	const norm = (v: string) => v.replace(/[  ]/g, ' ');
	const write = (locale: string, options: Intl.DateTimeFormatOptions) =>
		norm(new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(thursday));
	const short = { weekday: 'short', day: 'numeric', month: 'short' } as const;
	const numeric = { day: '2-digit', month: '2-digit', year: 'numeric' } as const;

	it("writes the language's words in the region's order where Intl knows both together", () => {
		const english = dateLocale('en', 'sl-SI', 'h23');
		expect(english).toBe('en-SI-u-hc-h23');
		expect(write(english, short)).toBe('Thu, 22 Oct');
		expect(write(english, numeric)).toBe('22/10/2026');
		expect(write(dateLocale('sl', 'sl-SI'), short)).toBe('čet., 22. okt.');
	});

	it('keeps the region format itself when it is in the reader language', () => {
		expect(dateLocale('en', 'en-GB')).toBe('en-GB');
		expect(dateLocale('tr', 'tr-TR', 'h23')).toBe('tr-TR-u-hc-h23');
		expect(write(dateLocale('en', 'en-US'), short)).toBe('Thu, Oct 22');
	});

	it("keeps the language's own phrasing where Intl does not know it in that region", () => {
		const turkish = dateLocale('tr', 'en-US', 'h12');
		expect(turkish).toBe('tr-u-hc-h12');
		expect(write(turkish, short)).toBe('22 Eki Per');
		expect(write(turkish, { hour: 'numeric', minute: '2-digit' })).toBe('ÖS 5:05');
	});

	it("carries the family's clock and the region's own digits and calendar", () => {
		expect(write(dateLocale('en', 'en-US', 'h23'), { hour: '2-digit', minute: '2-digit' })).toBe(
			'17:05',
		);
		expect(dateLocale('en', 'ar-EG-u-nu-arab')).toBe('en-u-nu-arab');
		expect(dateLocale('en', 'fa-IR-u-ca-persian')).toBe('en-u-ca-persian');
	});

	it('never fails on a tag Intl rejects', () => {
		expect(dateLocale('en', 'not a tag')).toBe('not a tag');
	});
});

describe('regionFormats', () => {
	it('lists each place once, with its most likely language', () => {
		const tags = regionFormats();
		expect(tags).toEqual(expect.arrayContaining(['sl-SI', 'en-US', 'tr-TR', 'pt-BR', 'de-CH']));
		const regions = tags.map((tag) => new Intl.Locale(tag).region);
		expect(new Set(regions).size).toBe(regions.length);
		expect(tags.length).toBeGreaterThan(200);
	});

	it('leaves out groupings, test regions and retired codes', () => {
		const regions = new Set(regionFormats().map((tag) => new Intl.Locale(tag).region));
		for (const code of ['EU', 'UN', 'EZ', 'QO', 'XA', 'XB', 'ZZ', 'UK', 'SU', 'YU'])
			expect(regions.has(code)).toBe(false);
	});
});

describe('daysAround', () => {
	it('gives each day around today with its weekday, from a week back to two weeks ahead', () => {
		// 13 October 2026 is a Tuesday.
		const days = daysAround('2026-10-13');
		expect(days).toHaveLength(22);
		expect(days[0]).toBe('Tue 2026-10-06');
		expect(days.slice(6, 9)).toEqual([
			'Mon 2026-10-12 (yesterday)',
			'Tue 2026-10-13 (today)',
			'Wed 2026-10-14 (tomorrow)',
		]);
		expect(days).toContain('Tue 2026-10-20');
		expect(days.at(-1)).toBe('Tue 2026-10-27');
	});

	it('keeps weekdays right across a month boundary and a daylight-saving change', () => {
		// Many zones leave summer time on Sunday 25 October 2026; the dates are plain days.
		const days = daysAround('2026-10-30', 7, 3);
		expect(days).toEqual([
			'Fri 2026-10-23',
			'Sat 2026-10-24',
			'Sun 2026-10-25',
			'Mon 2026-10-26',
			'Tue 2026-10-27',
			'Wed 2026-10-28',
			'Thu 2026-10-29 (yesterday)',
			'Fri 2026-10-30 (today)',
			'Sat 2026-10-31 (tomorrow)',
			'Sun 2026-11-01',
			'Mon 2026-11-02',
		]);
	});
});
