import { addDays, dayBounds, formatTime, type HourCycle, todayIn } from '@famos/time';

/** One occurrence from the calendar, as ambient mode reads it. */
export type AgendaItem = {
	id: string;
	title: string;
	allDay: boolean;
	/** Instants (epoch ms) of a timed event; `end` is null when it has none. */
	start: number | null;
	end: number | null;
	/** Plain dates of an all-day event (`endDate` is its last day). */
	startDate: string | null;
	endDate: string | null;
};

/** How the family writes times: their date locale and hour cycle, in their time zone. */
export type ClockFormat = { timeZone: string; dateLocale: string; hourCycle: HourCycle };

/** An event with no end still shows this long after it starts. */
const NO_END_GRACE_MS = 15 * 60_000;

/** What the slideshow's plan lists: the rest of today, else tomorrow, else nothing. */
export type Plan = {
	when: 'today' | 'tomorrow' | 'none';
	/** Titles of today's all-day events (only while the plan is today's). */
	allDay: string[];
	/** The timed events in order, with the start written the family's way. */
	events: { id: string; title: string; time: string }[];
	/** The first event still to start, which the plan marks; null when none is left to start. */
	nextId: string | null;
};

/**
 * What to show of the calendar now. A timed event stays in "today from now" until it ends (or 15
 * minutes after it starts when it has no end), so one in progress is still listed. When nothing
 * timed is left today, the first events of tomorrow take over; with neither, the plan is empty.
 * Times are written the family's way, so a family on a 24-hour clock reads "16:30" here just as
 * on Today.
 */
export function slideshowPlan(
	items: readonly AgendaItem[],
	now: number,
	format: ClockFormat,
): Plan {
	const today = todayIn(format.timeZone, now);
	const tomorrow = dayBounds(addDays(today, 1), format.timeZone);
	const nextDay = dayBounds(addDays(today, 2), format.timeZone);
	const timed = items
		.filter((e) => !e.allDay && e.start !== null)
		.toSorted((a, b) => (a.start as number) - (b.start as number));
	const write = (e: AgendaItem) => ({
		id: e.id,
		title: e.title,
		time: formatTime(e.start as number, format.timeZone, format.dateLocale, format.hourCycle),
	});

	const rest = timed.filter((e) => {
		const start = e.start as number;
		const end = e.end !== null && e.end > start ? e.end : start + NO_END_GRACE_MS;
		return start < tomorrow.start && end > now;
	});
	if (rest.length > 0) {
		const allDay = items
			.filter(
				(e) =>
					e.allDay &&
					e.startDate !== null &&
					e.startDate <= today &&
					(e.endDate ?? e.startDate) >= today,
			)
			.map((e) => e.title);
		const next = rest.find((e) => (e.start as number) > now);
		return { when: 'today', allDay, events: rest.map(write), nextId: next?.id ?? null };
	}

	const later = timed.filter(
		(e) => (e.start as number) >= tomorrow.start && (e.start as number) < nextDay.start,
	);
	if (later.length > 0)
		return { when: 'tomorrow', allDay: [], events: later.map(write), nextId: null };
	return { when: 'none', allDay: [], events: [], nextId: null };
}
