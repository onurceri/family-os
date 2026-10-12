import { AiContextSchema, defineAction } from '@famos/sdk';
import { addDays, todayIn, zoned } from '@famos/time';
import { z } from 'zod';
import { calendarView } from './capabilities.ts';
import { occurrencesBetween, sortOccurrences } from './store.ts';

/** How far ahead the AI is told about events: news that one moved is about something coming up. */
const CONTEXT_DAYS = 70;
/** The most events given to the AI; the soonest come first. */
const MAX_CONTEXT_EVENTS = 200;

const hhmm = (ms: number, timeZone: string) =>
	zoned(ms, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

/**
 * The family's own events of the coming weeks, for the AI: a message that says an event moved or
 * changed can then change the listed event instead of adding a second one. A repeating event is
 * listed once, at its next date.
 */
export const aiContextEvents = defineAction({
	id: 'calendar.aiContextEvents',
	title: 'Upcoming events, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: calendarView.id,
	async run(uow) {
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		const found = sortOccurrences(
			await occurrencesBetween(uow.db, today, addDays(today, CONTEXT_DAYS), timeZone),
			timeZone,
		);
		const seen = new Set<string>();
		const items: { id: string; label: string; details: string }[] = [];
		for (const o of found) {
			if (seen.has(o.eventId)) continue;
			seen.add(o.eventId);
			const date = o.allDay
				? (o.startDate as string)
				: zoned(o.start as number, timeZone)
						.toPlainDate()
						.toString();
			const time =
				!o.allDay && o.start !== null
					? `${hhmm(o.start, timeZone)}${o.end !== null ? `-${hhmm(o.end, timeZone)}` : ''}`
					: 'all day';
			items.push({
				id: o.eventId,
				label: o.title,
				details: [date, time, o.location, o.recurring ? 'repeats' : null]
					.filter(Boolean)
					.join(', '),
			});
			if (items.length >= MAX_CONTEXT_EVENTS) break;
		}
		return { kind: 'cal_event', label: 'Upcoming calendar events', items };
	},
});
