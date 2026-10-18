import { addDays, dayBounds, Temporal, weekOf } from '@famos/time';
import type { Occurrence } from '../contract/index.js';

/** Helpers of the wide calendar board (week columns and month grid). Dates are `YYYY-MM-DD`. */

/** The 42 dates (6 weeks) of the month containing `date`, starting on the family's week start. */
export function monthGrid(date: string, weekStart: number): string[] {
	const first = Temporal.PlainDate.from(date).with({ day: 1 }).toString();
	const start = (weekOf(first, weekStart)[0] as string) ?? first;
	return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The same day one month later or earlier (clamped to the end of a shorter month). */
export function shiftMonth(date: string, months: number): string {
	return Temporal.PlainDate.from(date).add({ months }).toString();
}

export const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);

/** A range of dates for display: "5 – 11 October 2026", in the family's format locale. */
export function rangeLabel(from: string, to: string, locale: string): string {
	const at = (date: string) => Date.parse(`${date}T12:00:00Z`);
	return new Intl.DateTimeFormat(locale, {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).formatRange(at(from), at(to));
}

/** "October 2026". */
export function monthLabel(date: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(Date.parse(`${date}T12:00:00Z`));
}

/** Colours that mark an occurrence: its subscription's, its members', or a neutral one. */
export function stripeColors(
	occurrence: Occurrence,
	members: readonly { id: string; color: string }[],
): string[] {
	if (occurrence.source) return [occurrence.source.color];
	const colors = members.filter((m) => occurrence.memberIds.includes(m.id)).map((m) => m.color);
	return colors.length ? colors : ['var(--ink-soft)'];
}

/** A CSS background for the colour stripe: one colour, or bands of the members' colours. */
export function stripeBackground(colors: readonly string[]): string {
	if (colors.length === 1) return colors[0] as string;
	const step = 100 / colors.length;
	return `linear-gradient(to bottom, ${colors
		.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`)
		.join(', ')})`;
}

/** Whether the occurrence is over (timed: it ended; all-day: its last day is before today). */
export function isPast(occurrence: Occurrence, now: number, today: string): boolean {
	if (occurrence.allDay) return (occurrence.endDate as string) < today;
	return occurrence.end !== null && occurrence.end <= now;
}

/**
 * Applies the member and calendar filters of the board. Selected members keep their events and
 * the whole family's; a hidden subscription drops its events. No selection means everyone.
 */
export function filterBoard(
	items: readonly Occurrence[],
	members: readonly string[],
	hiddenSources: readonly string[],
): Occurrence[] {
	return items.filter((o) => {
		if (o.source) return !hiddenSources.includes(o.source.id);
		if (members.length === 0 || o.memberIds.length === 0) return true;
		return o.memberIds.some((id) => members.includes(id));
	});
}

/** Whether an occurrence covers a local date (multi-day and past-midnight events included). */
export function onDay(o: Occurrence, date: string, timeZone: string): boolean {
	if (o.allDay) return (o.startDate as string) <= date && date <= (o.endDate as string);
	const { start, end } = dayBounds(date, timeZone);
	return (o.start as number) < end && (o.end as number) > start;
}
