import { Temporal } from '@famos/time';

/**
 * The hours a screen or a family device is dark, as clock times (`HH:MM`) in the family's time
 * zone. `from` is the first moment it is dark, `until` the first moment it is lit again; the
 * window crosses midnight when `until` is before `from`.
 */
export type SleepWindow = { from: string; until: string };

/** How long a touch keeps a dark device awake without any further use. */
export const WAKE_MS = 60_000;

function minutesOf(clock: string): number {
	const [hours = 0, minutes = 0] = clock.split(':').map(Number);
	return hours * 60 + minutes;
}

/** Whether `now` falls in the window: dark from `from` (included) until `until` (not included). */
export function isAsleep(now: number, timeZone: string, window: SleepWindow | null): boolean {
	if (!window) return false;
	const from = minutesOf(window.from);
	const until = minutesOf(window.until);
	if (from === until) return false;
	const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
	// Seconds, so the edges are exact: at `from` it is dark, at `until` it is lit.
	const minute = local.hour * 60 + local.minute + local.second / 60 + local.millisecond / 60_000;
	return from < until ? minute >= from && minute < until : minute >= from || minute < until;
}

function nextAt(now: number, timeZone: string, clock: string): number {
	const minutes = minutesOf(clock);
	const plainTime = { hour: Math.floor(minutes / 60), minute: minutes % 60 };
	const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
	const today = local.withPlainTime(plainTime);
	if (today.epochMilliseconds > now) return today.epochMilliseconds;
	return local.toPlainDate().add({ days: 1 }).toZonedDateTime({ timeZone, plainTime })
		.epochMilliseconds;
}

/**
 * The next moment the window starts or ends after `now` (so a timer need not poll every second);
 * null without a window. A clock time that a daylight saving change skips lands after the gap, so
 * a caller that must be exact on that day also checks again soon.
 */
export function nextChange(
	now: number,
	timeZone: string,
	window: SleepWindow | null,
): number | null {
	if (!window || window.from === window.until) return null;
	return Math.min(nextAt(now, timeZone, window.from), nextAt(now, timeZone, window.until));
}

/** When a touch last woke the device: the time its wake ends, or null when none is running. */
export type Awake = number | null;

/** A touch (or any use) while dark: awake for `WAKE_MS` from now. */
export function wokenAt(now: number): number {
	return now + WAKE_MS;
}

/** Whether the device is black now: inside the window and not within a minute of the last touch. */
export function isDark(
	now: number,
	timeZone: string,
	window: SleepWindow | null,
	awake: Awake,
): boolean {
	if (!isAsleep(now, timeZone, window)) return false;
	return awake === null || now >= awake;
}

/**
 * When to look again: the next start or end of the window, or the end of a wake that is running,
 * whichever comes first; null when nothing will change (no window).
 */
export function nextCheck(
	now: number,
	timeZone: string,
	window: SleepWindow | null,
	awake: Awake,
): number | null {
	const change = nextChange(now, timeZone, window);
	if (change === null) return null;
	return awake !== null && awake > now ? Math.min(change, awake) : change;
}

/**
 * The time the device stays dark until, written for the cover's accessible name: the end of the
 * window as a clock time in the family's zone (the caller writes it the reader's way).
 */
export function wakesAt(now: number, timeZone: string, window: SleepWindow): number {
	return nextAt(now, timeZone, window.until);
}
