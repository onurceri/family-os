import type { TimelineItem } from '../slots.js';
import { groupOf, sortTimeline } from './timeline.js';

/**
 * The shared model of Today in every style. Pure functions: the next-up item, its
 * countdown and pill, the day by person and each person's one-clause status, plus formatting
 * through `Intl` (`TodayFormat`: dates and times in the date locale). Other words come from the
 * caller's catalog (the `*Words` interfaces); this file holds none.
 */

/** Whose next thing the hero shows: the family's, or the signed-in person's. */
export type NextUpMode = 'family' | 'me';
export const NEXT_UP_MODES = ['family', 'me'] as const satisfies readonly NextUpMode[];

/** From this many minutes the countdown is a compact duration ("1 hr 55") instead of minutes. */
export const NEXT_UP_DURATION_FROM = 60;
/** From this many minutes the countdown is the start time itself. */
export const NEXT_UP_TIME_FROM = 120;

/** The family's region formats, and the reader's language for the words in dates and times. */
export interface TodayFormat {
	/** Numbers: the family's region format. */
	formatLocale: string;
	/** Dates, times and durations: `dateLocale` from `@famos/time` (words in the reader's language). */
	dateLocale: string;
	hourCycle: 'h12' | 'h23';
	timeZone: string;
}

const MINUTE = 60_000;
const TIMED = 1;
const ALL_DAY = 0;

/** A timed item with a clock (not a meal plan's nominal time). */
export const isTimed = (item: TimelineItem): boolean =>
	groupOf(item) === TIMED && item.start !== undefined && !item.nominal;

/** When a timed item ends (an item without an end ends when it starts). */
const endOf = (item: TimelineItem): number => item.end ?? item.start ?? 0;

/** Whether an item is the person's: they are among its members, or it has none ("anyone"). */
export const isMine = (item: TimelineItem, me: string): boolean =>
	(item.members ?? []).length === 0 || (item.members ?? []).includes(me);

/** Things that are a person's day; meals belong to the kitchen and chores to the rings. */
const isDayItem = (item: TimelineItem): boolean =>
	item.kind !== 'meal' && item.kind !== 'chore' && !item.nominal;

/**
 * The hero's item: the first timed item still to start; when nothing else starts today, the one
 * under way (the countdown then says "now"). In `me` mode only the person's items count (they
 * are among its members, or it has none); without a person `me` falls back to the family.
 */
export function nextUp(
	items: readonly TimelineItem[],
	now: number,
	mode: NextUpMode,
	me: string | null,
): TimelineItem | null {
	const timed = sortTimeline(items).filter(
		(item) => isTimed(item) && !item.done && (mode === 'family' || !me || isMine(item, me)),
	);
	return (
		timed.find((item) => (item.start as number) > now) ??
		timed.find((item) => (item.start as number) <= now && endOf(item) > now) ??
		null
	);
}

/**
 * The hero's countdown. Under an hour the minutes (the biggest number on the page); from one
 * hour a duration; from two hours the start time; once started, "now" and the end.
 */
export type Countdown =
	| { kind: 'minutes'; minutes: number }
	| { kind: 'duration'; minutes: number }
	| { kind: 'time'; at: number }
	| { kind: 'now'; until: number | null };

/** Whole minutes until `start`, rounded up so a countdown never says 0 before it starts. */
export const minutesUntil = (now: number, start: number): number =>
	Math.ceil((start - now) / MINUTE);

export function countdown(now: number, start: number, end?: number | null): Countdown {
	if (start <= now) return { kind: 'now', until: end != null && end > start ? end : null };
	const minutes = minutesUntil(now, start);
	if (minutes < NEXT_UP_DURATION_FROM) return { kind: 'minutes', minutes };
	if (minutes < NEXT_UP_TIME_FROM) return { kind: 'duration', minutes };
	return { kind: 'time', at: start };
}

/**
 * The pill on the hero: `Until <end>` once started, `At <place>` when the item has one, else
 * `Starts <time>`, except when the countdown already is the start time (then none).
 */
export type Pill =
	| { kind: 'until'; at: number }
	| { kind: 'at'; place: string }
	| { kind: 'starts'; at: number }
	| null;

export function pillOf(item: TimelineItem, count: Countdown): Pill {
	if (count.kind === 'now') return count.until === null ? null : { kind: 'until', at: count.until };
	const place = item.location?.trim();
	if (place) return { kind: 'at', place };
	if (count.kind === 'time' || item.start === undefined) return null;
	return { kind: 'starts', at: item.start };
}

/** One person's day: their all-day and timed items in the day's order. */
export interface PersonDay {
	memberId: string;
	items: TimelineItem[];
}

export interface MemberDays {
	/** One per member, in the members' order; an item with several members is in each. */
	people: PersonDay[];
	/** Items with no member ("anyone"). */
	family: TimelineItem[];
}

/** The day by person: all-day and timed items (not meals, chores or untimed tasks). */
export function memberDays(
	items: readonly TimelineItem[],
	members: readonly { id: string }[],
): MemberDays {
	const day = sortTimeline(items).filter(
		(item) => isDayItem(item) && (groupOf(item) === ALL_DAY || isTimed(item)),
	);
	return {
		people: members.map((m) => ({
			memberId: m.id,
			items: day.filter((item) => (item.members ?? []).includes(m.id)),
		})),
		family: day.filter((item) => (item.members ?? []).length === 0),
	};
}

/** Chores of the day for one person (`memberId: null` is "anyone"), as `chores.todayByMember`. */
export interface ChoreCount {
	memberId: string | null;
	done: number;
	total: number;
}

/**
 * A person's status: one clause, chosen in this order: their next timed item today, else their
 * all-day item, else the same of the events for everyone (events without members, which include
 * them), else chores left, else nothing planned. So a person is never "nothing planned" while
 * the family has a plan, and their own things still come first. Chores never join another clause;
 * the rings carry them.
 */
export type Status =
	| { kind: 'now'; item: TimelineItem; until: number }
	| { kind: 'soon'; item: TimelineItem; minutes: number }
	| { kind: 'at'; item: TimelineItem; at: number }
	| { kind: 'allday'; item: TimelineItem }
	| { kind: 'chores'; left: number }
	| { kind: 'nothing' };

/** The next timed item still to end, else the first all-day item, as a status. */
function itemStatus(items: readonly TimelineItem[], now: number): Status | null {
	const next = items.find((item) => isTimed(item) && endOf(item) > now);
	if (next) {
		const start = next.start as number;
		// Under way: it has an end after now (an item without an end has ended when it starts).
		if (start <= now) return { kind: 'now', item: next, until: endOf(next) };
		const minutes = minutesUntil(now, start);
		if (minutes < NEXT_UP_DURATION_FROM) return { kind: 'soon', item: next, minutes };
		return { kind: 'at', item: next, at: start };
	}
	const allDay = items.find((item) => groupOf(item) === ALL_DAY);
	return allDay ? { kind: 'allday', item: allDay } : null;
}

export function statusOf(
	memberId: string,
	items: readonly TimelineItem[],
	chores: readonly ChoreCount[],
	now: number,
): Status {
	const open = sortTimeline(items).filter((item) => isDayItem(item) && !item.done);
	const own = open.filter((item) => (item.members ?? []).includes(memberId));
	// An event without members is for everyone; a task without one is for whoever does it, so
	// it is not each person's.
	const family = open.filter((item) => item.kind === 'event' && (item.members ?? []).length === 0);
	const status = itemStatus(own, now) ?? itemStatus(family, now);
	if (status) return status;
	const left = choresLeft(memberId, chores);
	if (left > 0) return { kind: 'chores', left };
	return { kind: 'nothing' };
}

/** Chores left for a person (0 when none), for the meta line under "Nothing planned." */
export function choresLeft(memberId: string | null, chores: readonly ChoreCount[]): number {
	const mine = chores.find((c) => c.memberId === memberId);
	return mine ? Math.max(0, mine.total - mine.done) : 0;
}

// ---------------------------------------------------------------- formatting

/** A clock time in the family's time zone, date locale and hour cycle ("15:45", "3:45 PM"). */
export function formatClock(at: number, format: TodayFormat): string {
	return new Intl.DateTimeFormat(format.dateLocale, {
		hour: format.hourCycle === 'h12' ? 'numeric' : '2-digit',
		minute: '2-digit',
		timeZone: format.timeZone,
		hourCycle: format.hourCycle,
	}).format(at);
}

/** A whole number in the format locale. */
export const formatNumber = (value: number, locale: string): string =>
	new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

/**
 * Minutes as a number and its unit, from `Intl.NumberFormat`'s parts ("25" and "minutes"): the
 * unit written out, as it stands alone under the number where a short form is hard to read.
 */
export function minuteParts(minutes: number, locale: string): { value: string; unit: string } {
	const parts = new Intl.NumberFormat(locale, {
		style: 'unit',
		unit: 'minute',
		unitDisplay: 'long',
	}).formatToParts(minutes);
	return {
		value: parts
			.filter((p) => p.type === 'integer' || p.type === 'group')
			.map((p) => p.value)
			.join(''),
		unit: parts.find((p) => p.type === 'unit')?.value ?? '',
	};
}

type DurationStyle = 'short' | 'long';
interface DurationFormatter {
	format(duration: { hours?: number; minutes?: number }): string;
}
type DurationFormatCtor = new (
	locale: string,
	options: { style: DurationStyle },
) => DurationFormatter;

/**
 * Minutes as a duration ("1 hr, 55 min", "1 sa. 55 dk."): `Intl.DurationFormat` where the
 * browser has it, else the hours and minutes from `Intl.NumberFormat` joined by a space.
 */
export function formatDuration(minutes: number, locale: string, style: DurationStyle = 'short') {
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	const duration = {
		...(hours > 0 && { hours }),
		...((rest > 0 || hours === 0) && { minutes: rest }),
	};
	const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatCtor })
		.DurationFormat;
	if (DurationFormat) return new DurationFormat(locale, { style }).format(duration);
	const unit = (u: 'hour' | 'minute', value: number) =>
		new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: style }).format(value);
	return [
		duration.hours !== undefined ? unit('hour', duration.hours) : '',
		duration.minutes !== undefined ? unit('minute', duration.minutes) : '',
	]
		.filter(Boolean)
		.join(' ');
}

/** The countdown's words (catalog strings, already translated). */
export interface CountdownWords {
	/** Under a duration: "to go". */
	toGo: string;
	/** Between the hours and the minutes of a duration, small: "hr" in "1 hr 46". */
	hours: string;
	/** Under the start time: "starts". */
	starts: string;
	/** Instead of a number once started: "now". */
	now: string;
	/** In the accessible name: "in 25 minutes" from a long duration. */
	inDuration(duration: string): string;
	/** In the accessible name once started: "now, until 16:30". */
	nowUntil(time: string): string;
}

/** What the countdown shows: the value (the big number) and the caption under it. */
export interface CountdownView {
	kind: Countdown['kind'];
	value: string;
	caption: string;
	/** A duration in parts, for the big face: the hours, the small unit, the minutes ("1", "hr", "46"). */
	parts?: { hours: string; unit: string; minutes: string };
}

/**
 * A duration as the countdown's compact parts: whole hours and the rest in two digits, both in
 * the family's format locale ("1" and "46", "2" and "05"), so the big face reads "1 hr 46".
 */
export function durationParts(minutes: number, locale: string): { hours: string; minutes: string } {
	const whole = Math.max(0, Math.round(minutes));
	return {
		hours: new Intl.NumberFormat(locale, { useGrouping: false }).format(Math.floor(whole / 60)),
		minutes: new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }).format(
			whole % 60,
		),
	};
}

export function showCountdown(
	count: Countdown,
	format: TodayFormat,
	words: CountdownWords,
): CountdownView {
	switch (count.kind) {
		case 'minutes': {
			const { value, unit } = minuteParts(count.minutes, format.dateLocale);
			return { kind: count.kind, value, caption: unit };
		}
		case 'duration': {
			const { hours, minutes } = durationParts(count.minutes, format.formatLocale);
			return {
				kind: count.kind,
				value: `${hours} ${words.hours} ${minutes}`,
				caption: words.toGo,
				parts: { hours, unit: words.hours, minutes },
			};
		}
		case 'time':
			return { kind: count.kind, value: formatClock(count.at, format), caption: words.starts };
		case 'now':
			return { kind: count.kind, value: words.now, caption: '' };
	}
}

/** The hero's accessible name: "Piano lesson, 15:45, in 25 minutes". */
export function countdownName(
	item: TimelineItem,
	now: number,
	format: TodayFormat,
	words: CountdownWords,
): string {
	const start = item.start ?? now;
	const count = countdown(now, start, item.end);
	const when =
		count.kind === 'now'
			? count.until === null
				? words.now
				: words.nowUntil(formatClock(count.until, format))
			: words.inDuration(formatDuration(minutesUntil(now, start), format.dateLocale, 'long'));
	return `${item.title}, ${formatClock(start, format)}, ${when}`;
}

/** The pill's words (catalog strings). */
export interface PillWords {
	at(place: string): string;
	starts(time: string): string;
	until(time: string): string;
}

export function pillText(pill: Pill, format: TodayFormat, words: PillWords): string | null {
	if (!pill) return null;
	if (pill.kind === 'at') return words.at(pill.place);
	if (pill.kind === 'starts') return words.starts(formatClock(pill.at, format));
	return words.until(formatClock(pill.at, format));
}

/** The status line's words (catalog strings), one per shape. */
export interface StatusWords {
	/** "Piano lesson in 25 min". */
	soon(title: string, duration: string): string;
	/** "Football 17:00". */
	at(title: string, time: string): string;
	/** "Piano lesson until 16:30" (under way). */
	until(title: string, time: string): string;
	/** "1 chore left". */
	choresLeft(count: number): string;
	/** "Nothing planned". */
	nothing: string;
}

/** A status as one clause of text. */
export function statusText(status: Status, format: TodayFormat, words: StatusWords): string {
	switch (status.kind) {
		case 'now':
			return words.until(status.item.title, formatClock(status.until, format));
		case 'soon':
			return words.soon(status.item.title, formatDuration(status.minutes, format.dateLocale));
		case 'at':
			return words.at(status.item.title, formatClock(status.at, format));
		case 'allday':
			return status.item.title;
		case 'chores':
			return words.choresLeft(status.left);
		case 'nothing':
			return words.nothing;
	}
}

/**
 * The month a photo was added (`YYYY-MM`, from `GET /ambient/photos/today`) as words in the
 * date locale ("October 2025"), for "From the photos · {{month}}". Empty when malformed.
 */
export function formatPhotoMonth(month: string, locale: string): string {
	const match = /^(\d{4})-(\d{2})$/.exec(month);
	if (!match) return '';
	const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, 15);
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(at);
}
