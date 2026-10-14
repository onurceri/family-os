import { type DbExecutor, type DraftAlternative, labelNamesTitle, namedShares } from '@famos/sdk';
import { addDays, zoned } from '@famos/time';
import type { EventInput, Occurrence } from '../contract/index.ts';
import { occurrencesBetween, SAME_EVENT_DAYS } from './store.ts';

/** The day and the time of day (timed occurrences) an occurrence starts, in the family time zone. */
function startOf(o: Occurrence, timeZone: string): { date: string; time?: string } {
	if (o.allDay) return { date: o.startDate as string };
	const at = zoned(o.start as number, timeZone);
	return { date: at.toPlainDate().toString(), time: at.toPlainTime().toString().slice(0, 5) };
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * A new event that is an event already on the calendar at another day or time: news that it moved
 * arrives with the new day and time, and the person means the event they have, not a second one.
 * The change that moves that event (or, for a repeating event, the one date of it nearest the new
 * day) to what the new event says, or null.
 *
 * Only an event whose title and the new title name each other word for word (`labelNamesTitle`)
 * counts, within a month either side. When several events do, the one the new title names most
 * (`namedShares`) is meant; a tie names none of them. A new event that is already there at that
 * very time, or a new repeating event, is not a move.
 */
export async function movedEvent(
	db: DbExecutor,
	input: EventInput,
	timeZone: string,
): Promise<DraftAlternative | null> {
	if (input.recurrence) return null;
	const near = await occurrencesBetween(
		db,
		addDays(input.date, -SAME_EVENT_DAYS),
		addDays(input.date, SAME_EVENT_DAYS),
		timeZone,
	);
	const named = near.filter((o) => labelNamesTitle(input.title, o.title));
	if (named.length === 0) return null;
	const allDay = input.allDay ?? false;
	const already = named.some((o) => {
		const at = startOf(o, timeZone);
		return o.allDay === allDay && at.date === input.date && (allDay || at.time === input.startTime);
	});
	if (already) return null;

	const ids = [...new Set(named.map((o) => o.eventId))];
	const titles = ids.map((id) => named.find((o) => o.eventId === id)?.title ?? '');
	const shares = namedShares(input.title, titles);
	const best = Math.max(...shares);
	const top = ids.filter((_, i) => shares[i] === best);
	if (top.length !== 1) return null;

	const nearest = named
		.filter((o) => o.eventId === top[0])
		.map((o) => ({ o, at: startOf(o, timeZone) }))
		.sort(
			(a, b) =>
				daysBetween(a.at.date, input.date) - daysBetween(b.at.date, input.date) ||
				a.at.date.localeCompare(b.at.date),
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
	return { actionId: 'calendar.changeEvent', input: change, at };
}
