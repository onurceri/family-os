import {
	compareThing,
	type DbExecutor,
	type DraftAlternative,
	matchThing,
	targetOf,
} from '@famos/sdk';
import { addDays, daysBetween, zoned } from '@famos/time';
import type { EventInput, Occurrence } from '../contract/index.ts';
import { occurrencesBetween, SAME_EVENT_DAYS } from './store.ts';

/** The day and the time of day (timed occurrences) an occurrence starts, in the family time zone. */
export function startOf(o: Occurrence, timeZone: string): { date: string; time?: string } {
	if (o.allDay) return { date: o.startDate as string };
	const at = zoned(o.start as number, timeZone);
	return { date: at.toPlainDate().toString(), time: at.toPlainTime().toString().slice(0, 5) };
}

/**
 * A new event that is an event already on the calendar at another day or time: news that it moved
 * arrives with the new day and time, and the person means the event they have, not a second one.
 * The change that moves that event (or, for a repeating event, the one date of it nearest the new
 * day) to what the new event says, or null.
 *
 * Only an event the new title surely names (`matchThing`, `exact` or `strong`: the words of one
 * title are all words of the other, and no code or number differs), or the one event it names by
 * the same code ("U13 fixture" for "U13 Eagles away game"), counts, within a month either side:
 * the move is only offered, and the person decides. When several events are named, the one the
 * new title names most is meant; a tie, or a title that only partly names an event, names none
 * of them. A new event that is already there at that
 * very time, or a new repeating event, is not a move.
 */
export async function movedEvent(
	db: DbExecutor,
	input: EventInput,
	settings: { timeZone: string; locale: string },
): Promise<DraftAlternative | null> {
	if (input.recurrence) return null;
	const { timeZone } = settings;
	const words = { language: settings.locale };
	const near = await occurrencesBetween(
		db,
		addDays(input.date, -SAME_EVENT_DAYS),
		addDays(input.date, SAME_EVENT_DAYS),
		timeZone,
	);
	const named = near.filter((o) => {
		const { band, reason } = compareThing(input.title, o.title, words);
		return band === 'exact' || band === 'strong' || reason === 'code';
	});
	if (named.length === 0) return null;
	const allDay = input.allDay ?? false;
	const already = named.some((o) => {
		const at = startOf(o, timeZone);
		return o.allDay === allDay && at.date === input.date && (allDay || at.time === input.startTime);
	});
	if (already) return null;

	const events = new Map(named.map((o) => [o.eventId, { id: o.eventId, label: o.title }]));
	const match = matchThing(input.title, [...events.values()], words);
	if (targetOf(match) === null) return null;
	const chosen = match.candidate?.id;

	const nearest = named
		.filter((o) => o.eventId === chosen)
		.map((o) => ({ o, at: startOf(o, timeZone) }))
		.sort(
			(a, b) =>
				Math.abs(daysBetween(a.at.date, input.date)) -
					Math.abs(daysBetween(b.at.date, input.date)) || a.at.date.localeCompare(b.at.date),
		)[0];
	if (!nearest) return null;
	const { o, at } = nearest;

	const change: Record<string, unknown> = { id: o.eventId, label: o.title, date: input.date };
	if (o.recurring) change.occurrence = o.key;
	if (allDay) {
		if (!o.allDay) change.allDay = true;
		if (input.endDate) change.endDate = input.endDate;
	} else {
		if (o.allDay) change.allDay = false;
		change.startTime = input.startTime;
		if (input.endTime) change.endTime = input.endTime;
	}
	if (input.location && input.location !== o.location) change.location = input.location;
	return {
		actionId: 'calendar.changeEvent',
		input: change,
		at,
		to: allDay ? { date: input.date } : { date: input.date, time: input.startTime as string },
		key: 'calendar:draft_already_there',
	};
}
