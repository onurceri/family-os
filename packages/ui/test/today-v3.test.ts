import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type ChoreCount,
	type CountdownWords,
	choresLeft,
	countdown,
	countdownName,
	durationParts,
	formatClock,
	formatDuration,
	formatPhotoMonth,
	memberDays,
	minuteParts,
	NEXT_UP_DURATION_FROM,
	NEXT_UP_TIME_FROM,
	nextUp,
	type PillWords,
	pillOf,
	pillText,
	type StatusWords,
	showCountdown,
	statusOf,
	statusText,
	type TodayFormat,
} from '../src/famos/today-v3.js';
import type { TimelineItem } from '../src/slots.js';

const MIN = 60_000;
/** 2026-10-08 12:00 UTC; the family is in UTC so the clock reads as written. */
const NOON = Date.UTC(2026, 9, 8, 12);
const at = (hh: number, mm = 0) => Date.UTC(2026, 9, 8, hh, mm);
const fmt: TodayFormat = {
	formatLocale: 'en-GB',
	dateLocale: 'en-GB',
	hourCycle: 'h23',
	timeZone: 'UTC',
};

const item = (id: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id,
	title: id,
	kind: 'event',
	href: '/calendar',
	...extra,
});
const timed = (id: string, from: number, to?: number, extra: Partial<TimelineItem> = {}) =>
	item(id, { start: from, ...(to !== undefined && { end: to }), ...extra });

const countdownWords: CountdownWords = {
	toGo: 'to go',
	hours: 'hr',
	starts: 'starts',
	now: 'now',
	inDuration: (d) => `in ${d}`,
	nowUntil: (t) => `now, until ${t}`,
};
const pillWords: PillWords = {
	at: (p) => `At ${p}`,
	starts: (t) => `Starts ${t}`,
	until: (t) => `Until ${t}`,
};
const statusWords: StatusWords = {
	soon: (title, d) => `${title} in ${d}`,
	at: (title, t) => `${title} ${t}`,
	until: (title, t) => `${title} until ${t}`,
	choresLeft: (n) => `${n} chore${n === 1 ? '' : 's'} left`,
	nothing: 'Nothing planned',
};

describe('nextUp: Family or Me', () => {
	const items = [
		timed('school run', at(8), at(8, 30), { members: ['amy'] }),
		item('trip', { slot: 'allday', members: ['elif'] }),
		timed('lunch plan', at(12, 30), undefined, { kind: 'meal', nominal: true }),
		timed('piano', at(15, 45), at(16, 30), { members: ['elif'] }),
		timed('bins', at(17), undefined, { members: [] }),
		timed('football', at(18), at(19), { members: ['deniz', 'kai'] }),
	];

	it("Family is the family's next timed item, never an all-day, past or nominal one", () => {
		expect(nextUp(items, NOON, 'family', 'deniz')?.id).toBe('piano');
	});

	it('Me is the next item the person is among the members of, or that has no member', () => {
		// "bins" has no member: it is anyone's, so it is Deniz's next before football.
		expect(nextUp(items, NOON, 'me', 'deniz')?.id).toBe('bins');
		expect(nextUp(items, at(17, 30), 'me', 'deniz')?.id).toBe('football');
		expect(nextUp(items, NOON, 'me', 'elif')?.id).toBe('piano');
		// Amy has nothing of her own left: the "anyone" item is hers.
		expect(nextUp(items, NOON, 'me', 'amy')?.id).toBe('bins');
	});

	it('Me without a person is Family', () => {
		expect(nextUp(items, NOON, 'me', null)?.id).toBe('piano');
	});

	it('keeps the item under way when nothing else starts, and is empty after the day', () => {
		expect(nextUp(items, at(18, 30), 'family', null)?.id).toBe('football');
		expect(nextUp(items, at(19), 'family', null)).toBeNull();
		expect(nextUp([], NOON, 'family', null)).toBeNull();
	});

	it('skips done items', () => {
		expect(nextUp([timed('a', at(13), at(14), { done: true })], NOON, 'family', null)).toBeNull();
	});
});

describe('countdown thresholds', () => {
	const start = (minutes: number) => NOON + minutes * MIN;

	it('is minutes under an hour (59), a duration from 60 to 119, the time from 120', () => {
		expect(NEXT_UP_DURATION_FROM).toBe(60);
		expect(NEXT_UP_TIME_FROM).toBe(120);
		expect(countdown(NOON, start(1))).toEqual({ kind: 'minutes', minutes: 1 });
		expect(countdown(NOON, start(59))).toEqual({ kind: 'minutes', minutes: 59 });
		expect(countdown(NOON, start(60))).toEqual({ kind: 'duration', minutes: 60 });
		expect(countdown(NOON, start(119))).toEqual({ kind: 'duration', minutes: 119 });
		expect(countdown(NOON, start(120))).toEqual({ kind: 'time', at: start(120) });
	});

	it('rounds a part minute up, so it never says 0 before the start', () => {
		expect(countdown(NOON, NOON + 10_000)).toEqual({ kind: 'minutes', minutes: 1 });
		expect(countdown(NOON, start(59) + 30_000)).toEqual({ kind: 'duration', minutes: 60 });
	});

	it('is "now" with the end once started', () => {
		expect(countdown(NOON, NOON, at(13))).toEqual({ kind: 'now', until: at(13) });
		expect(countdown(NOON, at(11), at(13))).toEqual({ kind: 'now', until: at(13) });
		expect(countdown(NOON, at(11))).toEqual({ kind: 'now', until: null });
	});
});

describe('the pill', () => {
	it('says where when there is a place', () => {
		const piano = timed('piano', at(12, 25), at(13), { location: 'Music school' });
		expect(pillOf(piano, countdown(NOON, at(12, 25)))).toEqual({
			kind: 'at',
			place: 'Music school',
		});
		// Also when the countdown is the time: the place is new information.
		expect(pillOf(piano, countdown(NOON, at(15)))).toEqual({ kind: 'at', place: 'Music school' });
	});

	it('says when, unless the countdown already is the start time', () => {
		const swim = timed('swim', at(12, 25), at(13));
		expect(pillOf(swim, countdown(NOON, at(12, 25)))).toEqual({ kind: 'starts', at: at(12, 25) });
		expect(pillOf(swim, countdown(NOON, at(13, 30)))).toEqual({ kind: 'starts', at: at(12, 25) });
		expect(pillOf(timed('late', at(15)), countdown(NOON, at(15)))).toBeNull();
		expect(
			pillOf(timed('blank', at(13), at(14), { location: '  ' }), countdown(NOON, at(15))),
		).toBeNull();
	});

	it('says until when once started, whatever the place', () => {
		const started = timed('piano', at(11, 45), at(12, 30), { location: 'Music school' });
		const count = countdown(NOON, at(11, 45), at(12, 30));
		expect(pillOf(started, count)).toEqual({ kind: 'until', at: at(12, 30) });
		expect(pillOf(started, countdown(NOON, at(11, 45)))).toBeNull();
	});

	it('is text through the catalog words and the clock', () => {
		expect(pillText({ kind: 'at', place: 'Pool' }, fmt, pillWords)).toBe('At Pool');
		expect(pillText({ kind: 'starts', at: at(15, 45) }, fmt, pillWords)).toBe('Starts 15:45');
		expect(pillText({ kind: 'until', at: at(16, 30) }, fmt, pillWords)).toBe('Until 16:30');
		expect(pillText(null, fmt, pillWords)).toBeNull();
	});
});

describe('memberDays', () => {
	it('gives each member their all-day and timed items in order, and anyone’s apart', () => {
		const days = memberDays(
			[
				timed('football', at(18), at(19), { members: ['deniz', 'kai'] }),
				item('wfh', { slot: 'allday', members: ['deniz'] }),
				timed('dentist', at(9), at(10), { members: ['deniz'] }),
				timed('dinner', at(19), undefined, { kind: 'meal', nominal: true }),
				timed('dishes', at(20), undefined, { kind: 'chore', members: ['kai'] }),
				item('buy milk', { slot: 'anytime', kind: 'task', members: ['kai'] }),
				timed('bins', at(17)),
			],
			[{ id: 'deniz' }, { id: 'kai' }, { id: 'amy' }],
		);
		expect(days.people.map((p) => [p.memberId, p.items.map((i) => i.id)])).toEqual([
			['deniz', ['wfh', 'dentist', 'football']],
			['kai', ['football']],
			['amy', []],
		]);
		expect(days.family.map((i) => i.id)).toEqual(['bins']);
	});
});

describe('statusOf: one clause, in order', () => {
	const chores: ChoreCount[] = [
		{ memberId: 'elif', done: 1, total: 2 },
		{ memberId: 'deniz', done: 3, total: 3 },
		{ memberId: null, done: 0, total: 4 },
	];
	const text = (memberId: string, items: TimelineItem[], now = NOON) =>
		statusText(statusOf(memberId, items, chores, now), fmt, statusWords);

	it('the next timed item first: minutes under an hour, else its time', () => {
		const items = [
			item('wfh', { slot: 'allday', members: ['elif'] }),
			timed('piano', at(12, 25), at(13), { members: ['elif'] }),
			timed('football', at(17), at(18), { members: ['elif'] }),
		];
		expect(statusOf('elif', items, chores, NOON)).toMatchObject({ kind: 'soon', minutes: 25 });
		expect(text('elif', items)).toBe('piano in 25 mins');
		expect(text('elif', items, at(13))).toBe('football 17:00');
		expect(text('elif', items, at(12, 40))).toBe('piano until 13:00');
	});

	it('else an all-day item, else chores left, else nothing planned', () => {
		const allDay = [item('Working from home', { slot: 'allday', members: ['elif'] })];
		expect(text('elif', allDay)).toBe('Working from home');
		expect(text('elif', [])).toBe('1 chore left');
		expect(text('deniz', [])).toBe('Nothing planned');
		expect(text('amy', [])).toBe('Nothing planned');
	});

	it('is one clause: chores never join an item, and a person’s own things come first', () => {
		const items = [
			timed('piano', at(15, 45), at(16, 30), { members: ['elif'] }),
			timed('bins', at(12, 30)),
		];
		const line = text('elif', items);
		expect(line).toBe('piano 15:45');
		expect(line).not.toMatch(/chore/);
	});

	it('gives the whole family’s plan to a person with nothing of their own', () => {
		const dinner = timed('dinner', at(19), at(20));
		expect(text('amy', [dinner])).toBe('dinner 19:00');
		// Before their chores: the rings already show those.
		expect(text('elif', [dinner])).toBe('dinner 19:00');
		const holiday = item('Holiday', { slot: 'allday' });
		expect(text('amy', [holiday])).toBe('Holiday');
		const wfh = item('Working from home', { slot: 'allday', members: ['amy'] });
		expect(text('amy', [holiday, wfh])).toBe('Working from home');
		expect(text('amy', [{ ...dinner, done: true }])).toBe('Nothing planned');
		// A task nobody was given is for whoever does it, not each person's.
		expect(text('amy', [timed('vet call', at(17), undefined, { kind: 'task' })])).toBe(
			'Nothing planned',
		);
	});

	it('ignores meals, chores as items and past items', () => {
		const items = [
			timed('lunch', at(12, 30), undefined, { kind: 'meal', members: ['elif'] }),
			timed('dishes', at(12, 30), undefined, { kind: 'chore', members: ['elif'] }),
			timed('school', at(8), at(11), { members: ['elif'] }),
		];
		expect(text('elif', items)).toBe('1 chore left');
	});

	it('counts chores left for a person and for anyone', () => {
		expect(choresLeft('elif', chores)).toBe(1);
		expect(choresLeft(null, chores)).toBe(4);
		expect(choresLeft('kai', chores)).toBe(0);
	});
});

describe('formatting in the family’s format locale', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('formats durations in two format locales', () => {
		expect(formatDuration(115, 'en-US')).toBe('1 hr, 55 min');
		expect(formatDuration(115, 'tr-TR')).toBe('1 sa. 55 dk.');
		expect(formatDuration(25, 'en-US')).toBe('25 min');
		expect(formatDuration(120, 'en-US')).toBe('2 hr');
		expect(formatDuration(25, 'en-US', 'long')).toBe('25 minutes');
		expect(formatDuration(115, 'tr-TR', 'long')).toBe('1 saat 55 dakika');
	});

	it('falls back to NumberFormat units without Intl.DurationFormat', () => {
		vi.stubGlobal('Intl', Object.create(Intl, { DurationFormat: { value: undefined } }));
		expect(formatDuration(115, 'en-US')).toBe('1 hr 55 min');
		expect(formatDuration(115, 'tr-TR')).toBe('1 sa. 55 dk.');
		expect(formatDuration(60, 'en-US')).toBe('1 hr');
	});

	it('splits minutes into the number and its unit', () => {
		expect(minuteParts(25, 'en-GB')).toEqual({ value: '25', unit: 'minutes' });
		expect(minuteParts(1, 'en-GB')).toEqual({ value: '1', unit: 'minute' });
		expect(minuteParts(25, 'tr-TR')).toEqual({ value: '25', unit: 'dakika' });
	});

	it('writes the clock in the hour cycle and the photo month in the locale', () => {
		expect(formatClock(at(15, 45), fmt)).toBe('15:45');
		expect(formatClock(at(15, 45), { ...fmt, dateLocale: 'en-US', hourCycle: 'h12' })).toBe(
			'3:45 PM',
		);
		expect(formatPhotoMonth('2025-10', 'en-GB')).toBe('October 2025');
		expect(formatPhotoMonth('2025-10', 'tr-TR')).toBe('Ekim 2025');
		expect(formatPhotoMonth('nope', 'en-GB')).toBe('');
	});

	it('shows each countdown shape with its caption', () => {
		expect(showCountdown(countdown(NOON, at(12, 25)), fmt, countdownWords)).toEqual({
			kind: 'minutes',
			value: '25',
			caption: 'minutes',
		});
		expect(showCountdown(countdown(NOON, at(13, 55)), fmt, countdownWords)).toEqual({
			kind: 'duration',
			value: '1 hr 55',
			caption: 'to go',
			parts: { hours: '1', unit: 'hr', minutes: '55' },
		});
		expect(showCountdown(countdown(NOON, at(15, 45)), fmt, countdownWords)).toEqual({
			kind: 'time',
			value: '15:45',
			caption: 'starts',
		});
		expect(showCountdown(countdown(NOON, at(11), at(13)), fmt, countdownWords)).toEqual({
			kind: 'now',
			value: 'now',
			caption: '',
		});
	});
});

describe('a countdown over an hour', () => {
	it('is compact: whole hours and the minutes in two digits', () => {
		expect(durationParts(106, 'en-GB')).toEqual({ hours: '1', minutes: '46' });
		expect(durationParts(65, 'en-GB')).toEqual({ hours: '1', minutes: '05' });
		expect(durationParts(119, 'tr-TR')).toEqual({ hours: '1', minutes: '59' });
	});

	it('writes its digits in the family’s format locale', () => {
		expect(durationParts(106, 'ar-EG')).toEqual({ hours: '١', minutes: '٤٦' });
	});
});

describe('the countdown’s accessible name', () => {
	const piano = timed('Piano lesson', at(15, 45), at(16, 30));

	it('reads "Piano lesson, 15:45, in 25 minutes"', () => {
		expect(countdownName(piano, at(15, 20), fmt, countdownWords)).toBe(
			'Piano lesson, 15:45, in 25 minutes',
		);
	});

	it('names longer waits as a duration, and the end once started', () => {
		expect(countdownName(piano, at(13, 50), fmt, countdownWords)).toBe(
			'Piano lesson, 15:45, in 1 hour, 55 minutes',
		);
		expect(countdownName(piano, at(16), fmt, countdownWords)).toBe(
			'Piano lesson, 15:45, now, until 16:30',
		);
	});
});
