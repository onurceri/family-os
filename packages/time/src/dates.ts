import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(value: string): boolean {
	if (!DATE.test(value)) return false;
	try {
		Temporal.PlainDate.from(value, { overflow: 'reject' });
		return true;
	} catch {
		return false;
	}
}

export function isValidTimeZone(value: string): boolean {
	try {
		Temporal.Now.zonedDateTimeISO(value);
		return true;
	} catch {
		return false;
	}
}

export const IsoDateSchema = z.string().refine(isValidDate, 'Expected a date as YYYY-MM-DD');
export const IsoTimeSchema = z.string().regex(TIME, 'Expected a time as HH:MM');
export const TimeZoneSchema = z.string().refine(isValidTimeZone, 'Unknown time zone');

/** Today's date (`YYYY-MM-DD`) in a time zone. */
export function todayIn(timeZone: string, now: number): string {
	return Temporal.Instant.fromEpochMilliseconds(now)
		.toZonedDateTimeISO(timeZone)
		.toPlainDate()
		.toString();
}

export function zoned(epochMs: number, timeZone: string): Temporal.ZonedDateTime {
	return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
}

/** The instant of a local date and time in a zone. Ambiguous/skipped times resolve like calendars do. */
export function epochOf(date: string, time: string, timeZone: string): number {
	return Temporal.PlainDateTime.from(`${date}T${time}`)
		.toZonedDateTime(timeZone, { disambiguation: 'compatible' })
		.toInstant().epochMilliseconds;
}

/** Start (inclusive) and end (exclusive) of a local day, as instants. A DST day lasts 23 or 25 hours. */
export function dayBounds(date: string, timeZone: string): { start: number; end: number } {
	const day = Temporal.PlainDate.from(date);
	return {
		start: day.toZonedDateTime({ timeZone }).toInstant().epochMilliseconds,
		end: day.add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant().epochMilliseconds,
	};
}

export function addDays(date: string, days: number): string {
	return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** Whole days from `a` to `b` (plain `YYYY-MM-DD` dates), negative when `b` is earlier. Right across DST. */
export function daysBetween(a: string, b: string): number {
	return Temporal.PlainDate.from(a).until(Temporal.PlainDate.from(b), { largestUnit: 'days' }).days;
}

export function compareDates(a: string, b: string): number {
	return Temporal.PlainDate.compare(Temporal.PlainDate.from(a), Temporal.PlainDate.from(b));
}
