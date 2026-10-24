import { addDays, epochOf, HOUR_MS } from '@famos/time';
import type { AwaitedChange } from '@famos/ui/app';
import {
	type EventDetail,
	EventInputSchema,
	endsNextDay,
	type Occurrence,
} from '../contract/index.js';

/** A new event someone asked for that waits for approval, drawn where it would be. */
export type WaitingOccurrence = Occurrence & { waiting: AwaitedChange };

/** Whether an occurrence is a waiting new event, not a saved one. */
export const isWaiting = (occurrence: Occurrence): occurrence is WaitingOccurrence =>
	'waiting' in occurrence && Boolean((occurrence as { waiting?: unknown }).waiting);

/** The action whose waiting suggestions are new events. */
export const NEW_EVENT_ACTION = 'calendar.createEvent';

/**
 * The occurrence a waiting new event would be, on its first day: a repeating one is drawn once,
 * where it starts. Its id names the suggestion, so it never matches a saved event. Null when the
 * input does not fit today's shape (one stored by another version).
 */
export function waitingOccurrence(
	change: AwaitedChange,
	timeZone: string,
): WaitingOccurrence | null {
	if (change.actionId !== NEW_EVENT_ACTION) return null;
	const parsed = EventInputSchema.safeParse(change.input);
	if (!parsed.success) return null;
	const v = parsed.data;
	const id = `waiting:${change.draftId ?? `${v.date}:${v.title}`}`;
	const base = {
		eventId: id,
		title: v.title,
		memberIds: v.memberIds,
		location: v.location ?? null,
		recurring: false,
		notes: null,
		source: null,
		editable: false,
		tags: v.tags ?? [],
		waiting: change,
	};
	if (v.allDay) {
		return {
			...base,
			key: v.date,
			allDay: true,
			start: null,
			end: null,
			startDate: v.date,
			endDate: v.endDate ?? v.date,
		};
	}
	const start = epochOf(v.date, v.startTime as string, timeZone);
	const end = v.endTime
		? epochOf(
				endsNextDay(v.startTime, v.endTime) ? addDays(v.date, 1) : v.date,
				v.endTime,
				timeZone,
			)
		: start + HOUR_MS;
	return {
		...base,
		key: String(start),
		allDay: false,
		start,
		end,
		startDate: null,
		endDate: null,
	};
}

/** The waiting new events among the waiting changes, oldest first as given. */
export function waitingOccurrences(
	changes: readonly AwaitedChange[],
	timeZone: string,
): WaitingOccurrence[] {
	return changes.flatMap((change) => {
		const occurrence = waitingOccurrence(change, timeZone);
		return occurrence ? [occurrence] : [];
	});
}

/** The details a waiting new event would have, for the panel that reads it. */
export function waitingDetail(occurrence: WaitingOccurrence): EventDetail {
	const v = EventInputSchema.parse(occurrence.waiting.input);
	return {
		id: occurrence.eventId,
		version: 0,
		title: v.title,
		allDay: v.allDay,
		date: v.date,
		endDate: v.endDate ?? null,
		startTime: v.startTime ?? null,
		endTime: v.endTime ?? null,
		memberIds: v.memberIds,
		location: v.location ?? null,
		notes: v.notes ?? null,
		recurrence: v.recurrence ?? null,
		reminder: v.reminder ?? null,
		rrule: null,
		tags: v.tags ?? [],
	};
}
