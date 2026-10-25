import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';
import { addDays, compareDates, IsoDateSchema, isValidDate, zoned } from './dates.ts';

/* ───────────────────────── Recurrence ───────────────────────── */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The weekday code (`MO` … `SU`) of an ISO date. */
export const weekdayOf = (date: string): Weekday =>
	WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1] as Weekday;

/**
 * The weekly repeat days after the date moved from `previousDate` to `nextDate`. A repeat that
 * is empty, or only held the old date's weekday, follows the date. Days the person chose
 * themselves are never dropped: the new date's weekday is added to them, so a weekly series
 * always includes the day it starts on. An incomplete date changes nothing. A `saved` item is
 * never changed by a date change: moving the start of "every Tuesday" leaves it as it is.
 */
export function weekdaysAfterDateChange(
	byDay: readonly string[],
	previousDate: string,
	nextDate: string,
	saved = false,
): string[] {
	if (saved || !ISO_DATE.test(nextDate)) return [...byDay];
	const next = weekdayOf(nextDate);
	if (byDay.includes(next)) return [...byDay];
	const followsDate =
		byDay.length === 0 ||
		(byDay.length === 1 && ISO_DATE.test(previousDate) && byDay[0] === weekdayOf(previousDate));
	return followsDate ? [next] : [...byDay, next];
}

/**
 * The first date on or after `startDate` that falls on one of the weekly `byDay` codes: the day
 * a new weekly series first turns up. It is the start date itself when that matches. Null when
 * no day is chosen or the date is incomplete.
 */
export function firstRepeatDate(startDate: string, byDay: readonly string[]): string | null {
	if (!ISO_DATE.test(startDate) || !isValidDate(startDate)) return null;
	const chosen = new Set(byDay.filter((d) => (WEEKDAYS as readonly string[]).includes(d)));
	if (chosen.size === 0) return null;
	for (let i = 0; i < 7; i++) {
		const date = addDays(startDate, i);
		if (chosen.has(weekdayOf(date))) return date;
	}
	return null;
}

/** What a saved repeating item's form says about its schedule: the repeat, the date and the weekly days. */
export interface RepeatEdit {
	repeat: string;
	date: string;
	byDay: readonly string[];
}

const REPEATS = ['daily', 'weekly', 'monthly'];

/**
 * Whether saving a repeating item must ask "only this one" or "this one and the ones after":
 * its date moved, or its weekly days changed, while it stays a repeat.
 */
export function repeatEditAsks(before: RepeatEdit, after: RepeatEdit): boolean {
	if (!REPEATS.includes(before.repeat) || !REPEATS.includes(after.repeat)) return false;
	if (before.date !== after.date) return true;
	return (
		before.repeat === 'weekly' &&
		after.repeat === 'weekly' &&
		[...before.byDay].sort().join() !== [...after.byDay].sort().join()
	);
}

/**
 * The date "only this one" lands on: the date typed when it moved, otherwise (the days changed)
 * the first date on or after `from` that matches the new days.
 */
export function onlyThisDate(before: RepeatEdit, after: RepeatEdit, from: string): string {
	if (before.date !== after.date) return after.date;
	const start = isValidDate(from) && compareDates(from, after.date) > 0 ? from : after.date;
	return firstRepeatDate(start, after.byDay) ?? after.date;
}

/**
 * The weekly days of "this one and the ones after": a lone day that was the old date's weekday
 * moves to the new date's weekday; days the person chose are kept as the form shows them.
 */
export function followingDays(before: RepeatEdit, after: RepeatEdit): string[] {
	const lone =
		after.byDay.length === 1 &&
		isValidDate(before.date) &&
		isValidDate(after.date) &&
		after.byDay[0] === weekdayOf(before.date);
	return lone ? [weekdayOf(after.date)] : [...after.byDay];
}

/** What each answer to "only this one, or this one and the ones after" does. */
export interface RepeatChoices {
	/** Only this one: the date it lands on. */
	onlyDate: string;
	/** This one and the ones after: the weekly days from now on. */
	days: string[];
	/** This one and the ones after: the first date of the new series. */
	nextDate: string;
}

export function repeatChoices(before: RepeatEdit, after: RepeatEdit, from: string): RepeatChoices {
	const days = after.repeat === 'weekly' ? followingDays(before, after) : [...after.byDay];
	return {
		onlyDate: onlyThisDate(before, after, from),
		days,
		nextDate: (after.repeat === 'weekly' ? firstRepeatDate(after.date, days) : null) ?? after.date,
	};
}

/**
 * The recurrence presets the UI offers. Stored as RRULE text, so anything CalDAV can express
 * still round-trips; `fromRRule` returns null for rules outside these presets.
 */
export const RecurrenceSchema = z.discriminatedUnion('freq', [
	z.object({
		freq: z.literal('daily'),
		interval: z.number().int().min(1).max(365).default(1),
		until: IsoDateSchema.optional(),
	}),
	z.object({
		freq: z.literal('weekly'),
		interval: z.number().int().min(1).max(52).default(1),
		byDay: z.array(z.enum(WEEKDAYS)).min(1).max(7),
		until: IsoDateSchema.optional(),
	}),
	z.object({
		freq: z.literal('monthly'),
		interval: z.number().int().min(1).max(12).default(1),
		until: IsoDateSchema.optional(),
	}),
]);
export type Recurrence = z.infer<typeof RecurrenceSchema>;

const compact = (date: string) => date.replaceAll('-', '');

/**
 * RRULE text for a preset. `UNTIL` is inclusive of the whole last day. For timed series pass the
 * time zone: `UNTIL` is the end of that day there, in UTC as RFC 5545 requires. For date series
 * (all-day events, tasks) pass `null`: `UNTIL` is a plain date, like their DTSTART.
 */
export function toRRule(recurrence: Recurrence, timeZone: string | null): string {
	const parts = [`FREQ=${recurrence.freq.toUpperCase()}`];
	if (recurrence.interval > 1) parts.push(`INTERVAL=${recurrence.interval}`);
	if (recurrence.freq === 'weekly') {
		const days = [...new Set(recurrence.byDay)].sort(
			(a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b),
		);
		parts.push(`BYDAY=${days.join(',')}`);
	}
	if (recurrence.until && timeZone === null) {
		parts.push(`UNTIL=${compact(recurrence.until)}`);
	} else if (recurrence.until && timeZone !== null) {
		const end = Temporal.PlainDate.from(recurrence.until)
			.toPlainDateTime({ hour: 23, minute: 59, second: 59 })
			.toZonedDateTime(timeZone)
			.toInstant()
			.toZonedDateTimeISO('UTC');
		parts.push(
			`UNTIL=${compact(end.toPlainDate().toString())}T${end.toPlainTime().toString().slice(0, 8).replaceAll(':', '')}Z`,
		);
	}
	return parts.join(';');
}

/** The preset behind an RRULE, or null when the rule uses features the presets don't cover. */
export function fromRRule(rrule: string, timeZone: string): Recurrence | null {
	const fields = new Map(
		rrule
			.replace(/^RRULE:/, '')
			.split(';')
			.map((p) => p.split('=') as [string, string]),
	);
	const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL']);
	if ([...fields.keys()].some((k) => !allowed.has(k))) return null;
	const freq = fields.get('FREQ')?.toLowerCase();
	const interval = Number(fields.get('INTERVAL') ?? 1);
	let until: string | undefined;
	const rawUntil = fields.get('UNTIL');
	if (rawUntil) {
		const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(rawUntil);
		if (!m) return null;
		until = m[4]
			? Temporal.Instant.from(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
					.toZonedDateTimeISO(timeZone)
					.toPlainDate()
					.toString()
			: `${m[1]}-${m[2]}-${m[3]}`;
	}
	const base = { freq, interval, ...(until && { until }) };
	const candidate =
		freq === 'weekly'
			? { ...base, byDay: (fields.get('BYDAY') ?? '').split(',').filter(Boolean) }
			: fields.has('BYDAY')
				? null
				: base;
	const parsed = RecurrenceSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

export interface TimedSeries {
	startsAt: number;
	timeZone: string;
	rrule: string | null;
	/** Excluded occurrence starts (epoch ms). */
	exdates?: readonly number[];
}

/** Occurrence starts of a timed event within [from, to). A non-recurring event yields its start if inside. */
export function expandTimed(series: TimedSeries, from: number, to: number): number[] {
	if (!series.rrule)
		return series.startsAt >= from && series.startsAt < to ? [series.startsAt] : [];
	const rule = new RRuleTemporal({
		rruleString: series.rrule,
		dtstart: zoned(series.startsAt, series.timeZone),
	});
	const excluded = new Set(series.exdates ?? []);
	return rule
		.between(new Date(from), new Date(to - 1), true)
		.map((z) => z.toInstant().epochMilliseconds)
		.filter((ms) => ms >= from && ms < to && !excluded.has(ms));
}

export interface DateSeries {
	date: string;
	rrule: string | null;
	exdates?: readonly string[];
}

/**
 * Occurrence dates of an all-day series (or a recurring task) within [from, to] inclusive.
 * Dates are expanded on a UTC calendar, so no time zone can shift them.
 */
export function expandDates(series: DateSeries, from: string, to: string): string[] {
	if (!series.rrule) {
		return compareDates(series.date, from) >= 0 && compareDates(series.date, to) <= 0
			? [series.date]
			: [];
	}
	const rule = new RRuleTemporal({
		rruleString: series.rrule,
		dtstart: Temporal.PlainDate.from(series.date).toZonedDateTime({ timeZone: 'UTC' }),
	});
	const start = Temporal.PlainDate.from(from).toZonedDateTime({ timeZone: 'UTC' });
	const end = Temporal.PlainDate.from(to).toZonedDateTime({ timeZone: 'UTC' });
	const excluded = new Set(series.exdates ?? []);
	return rule
		.between(start, end, true)
		.map((z) => z.toPlainDate().toString())
		.filter((d) => !excluded.has(d));
}

/** The first occurrence date strictly after `after` (for rolling a recurring task forward). */
export function nextDate(series: DateSeries, after: string): string | null {
	if (!series.rrule) return null;
	const rule = new RRuleTemporal({
		rruleString: series.rrule,
		dtstart: Temporal.PlainDate.from(series.date).toZonedDateTime({ timeZone: 'UTC' }),
	});
	const next = rule.next(
		Temporal.PlainDate.from(after).toZonedDateTime({ timeZone: 'UTC' }),
		false,
	);
	return next ? next.toPlainDate().toString() : null;
}
