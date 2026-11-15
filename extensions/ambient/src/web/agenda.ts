import { formatTime, type HourCycle } from '@famos/time';

/** A timed event of today as ambient mode lists it. */
export type AgendaEvent = { id: string; title: string; start: number };

/** How the family writes times: their date locale and hour cycle, in their time zone. */
export type ClockFormat = { timeZone: string; dateLocale: string; hourCycle: HourCycle };

/** An event that started this long ago still shows; after that it is over for this view. */
const STARTED_GRACE_MS = 15 * 60_000;

/**
 * The next events (at most `limit`) with their start time written the family's way, so a
 * family on a 24-hour clock reads "16:30" here just as on Today.
 */
export function nextEvents(
	agenda: readonly AgendaEvent[],
	now: number,
	format: ClockFormat,
	limit = 3,
): { id: string; title: string; time: string }[] {
	return agenda
		.filter((e) => e.start >= now - STARTED_GRACE_MS)
		.slice(0, limit)
		.map((e) => ({
			id: e.id,
			title: e.title,
			time: formatTime(e.start, format.timeZone, format.dateLocale, format.hourCycle),
		}));
}

/** Most timed events the slideshow lists over a photo. */
export const SLIDESHOW_ROWS = 3;

/** A viewport smaller than this (high or wide) is a phone or a short frame: one row only. */
const SHORT_SCREEN_PX = 600;

/**
 * How much of today's plan the slideshow writes over a photo: up to three rows, a "+N more"
 * line when there are more, and a taller dark gradient when there are two or more rows. A
 * short or narrow screen keeps one row and no "+N more".
 */
export function slideshowAgenda(
	remaining: number,
	viewport: { width: number; height: number },
): { rows: number; more: number; tallScrim: boolean } {
	const short = viewport.width < SHORT_SCREEN_PX || viewport.height < SHORT_SCREEN_PX;
	const rows = Math.min(Math.max(remaining, 0), short ? 1 : SLIDESHOW_ROWS);
	return {
		rows,
		more: short ? 0 : Math.max(remaining - SLIDESHOW_ROWS, 0),
		tallScrim: rows >= 2,
	};
}
