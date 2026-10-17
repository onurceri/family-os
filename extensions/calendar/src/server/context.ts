import { AiContextSchema, defineAction } from '@famos/sdk';
import { addDays, todayIn, zoned } from '@famos/time';
import { z } from 'zod';
import type { Occurrence } from '../contract/index.ts';
import { calendarView } from './capabilities.ts';
import { occurrencesBetween } from './store.ts';

/** How far ahead the AI is told about events: news of a cancelled or moved event is about soon. */
export const CONTEXT_DAYS = 28;
const MAX_CONTEXT_EVENTS = 100;
/** Dates of a repeating event listed before the rest are left out. */
const MAX_DATES = 5;
const MAX_DETAILS = 400;

/** When an occurrence starts, as the model writes it: `2026-10-15 17:30`, or the day alone. */
function when(o: Occurrence, timeZone: string): string {
	if (o.allDay) return `${o.startDate} (all day)`;
	const at = zoned(o.start as number, timeZone);
	return `${at.toPlainDate().toString()} ${at.toPlainTime().toString().slice(0, 5)}`;
}

/**
 * The family's own events of the next four weeks, soonest first, for the AI: a message that one
 * is cancelled or has moved then becomes a change to that event instead of a second event named
 * after the news. A repeating event is one entry with its dates, so a change can name the date it
 * is about (`occurrence`). Subscribed calendars are left out: they cannot be changed here. Read by
 * the Inbox as the AI actor.
 */
export const aiContextEvents = defineAction({
	id: 'calendar.aiContextEvents',
	title: 'Upcoming calendar events, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: calendarView.id,
	async run(uow) {
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		const near = await occurrencesBetween(uow.db, today, addDays(today, CONTEXT_DAYS), timeZone);
		const byEvent = new Map<string, Occurrence[]>();
		for (const o of near.filter((o) => o.source === null && o.editable)) {
			byEvent.set(o.eventId, [...(byEvent.get(o.eventId) ?? []), o]);
		}
		const items = [...byEvent.values()].slice(0, MAX_CONTEXT_EVENTS).map((dates) => {
			const first = dates[0] as Occurrence;
			const shown = dates.slice(0, MAX_DATES).map((o) => when(o, timeZone));
			const more = dates.length > MAX_DATES ? ', …' : '';
			const details = first.recurring
				? `repeats: ${shown.join(', ')}${more}; set occurrence to the date for one of them`
				: shown.join(', ');
			const place = first.location ? `; at ${first.location}` : '';
			return {
				id: first.eventId,
				label: first.title.slice(0, 160),
				details: `${details}${place}`.slice(0, MAX_DETAILS),
			};
		});
		return { kind: 'event', label: 'Upcoming calendar events', items };
	},
});
