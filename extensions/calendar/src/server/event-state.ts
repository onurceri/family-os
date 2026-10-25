import { type DuplicateContext, FamosError, type UnitOfWork } from '@famos/sdk';
import { occurrenceDetail } from './occurrences.ts';
import { type EventRow, effectiveReminder, events, toDetail, type toRow } from './store.ts';

export async function loadEvent(uow: UnitOfWork, id: string) {
	const row = await events(uow.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Event not found');
	return row;
}

/** The title of a live event, for the runner's check that an AI's label names the right one. */
export const eventTitle = async (ctx: DuplicateContext, { id }: { id: string }) =>
	(
		await events(ctx.db)
			.selectFrom('calendar_events')
			.select('title')
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst()
	)?.title ?? null;

/**
 * An event as a change sees it: the event (one date of it, given an occurrence key of a
 * repeating event) and its fields keyed like a change's input.
 */
export function eventAsItIs(row: EventRow, occurrence: string | undefined) {
	const series = toDetail(row);
	// For one date of a series, the event is that date as it is now; the rest is the series.
	const was = occurrence ? occurrenceDetail(row, series, occurrence) : series;
	const current: Record<string, unknown> = {
		title: was.title,
		allDay: was.allDay,
		date: was.date,
		endDate: was.endDate ?? undefined,
		startTime: was.startTime ?? undefined,
		endTime: was.endTime ?? undefined,
		memberIds: was.memberIds,
		location: was.location ?? undefined,
		notes: was.notes ?? undefined,
		tags: was.tags,
		recurrence: was.recurrence ?? undefined,
		reminder: row.reminder_set ? row.reminder_minutes : undefined,
	};
	return { was, current };
}

/** The fields that together say when an event is: a change of one is shown against all of them. */
export const WHEN_FIELDS = ['allDay', 'date', 'endDate', 'startTime', 'endTime'] as const;

/**
 * The fields (keyed like an event's input) in which a stored event and the row a whole new
 * version of it would write differ. Compared as stored, so a form that sends every field back as
 * it was changes nothing here.
 */
export function eventFieldsChanged(row: EventRow, next: ReturnType<typeof toRow>): string[] {
	const keys: string[] = [];
	if (row.title !== next.title) keys.push('title');
	const when =
		row.all_day !== next.all_day ||
		row.starts_at !== next.starts_at ||
		row.ends_at !== next.ends_at ||
		row.start_date !== next.start_date ||
		row.end_date !== next.end_date;
	if (when) keys.push(...WHEN_FIELDS);
	const people = (json: string) => [...(JSON.parse(json) as string[])].sort().join(',');
	if (people(row.member_ids) !== people(next.member_ids)) keys.push('memberIds');
	if ((row.location ?? null) !== next.location) keys.push('location');
	if ((row.notes ?? null) !== next.notes) keys.push('notes');
	if ((row.tags ?? null) !== next.tags) keys.push('tags');
	if ((row.rrule ?? null) !== next.rrule) keys.push('recurrence');
	// The reminder in effect: an event nobody chose one for has the default, which the form shows.
	if (effectiveReminder(row) !== effectiveReminder({ ...row, ...next })) keys.push('reminder');
	return keys;
}
