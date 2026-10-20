import {
	ApiDateSchema,
	ApiInstantSchema,
	apiId,
	apiInstant,
	apiOutput,
	defineApi,
} from '@famos/sdk';
import { addDays, epochOf, RecurrenceSchema } from '@famos/time';
import { z } from 'zod';
import type { EventDetail, Occurrence } from '../contract/index.ts';

/**
 * What the calendar offers on the public API. An event is written with its moment as an instant
 * (RFC 3339, with the offset of the family time zone) or, for an all-day event, as plain days;
 * the local `date`, `startTime` and `endTime` are the same moment as the family writes it, and are
 * what a change takes.
 */
const EventId = apiId('cal_event');
const MemberId = apiId('member');
const Moment = z.union([ApiInstantSchema, ApiDateSchema]);

export const PublicEventSchema = z
	.object({
		id: EventId,
		version: z
			.number()
			.int()
			.describe('Counts every write; send it as `If-Match` to change only an unchanged event'),
		title: z.string(),
		allDay: z.boolean(),
		start: Moment.describe('When it starts: an instant, or the first day of an all-day event'),
		end: Moment.describe(
			'When it ends: an instant, or the last day (inclusive) of an all-day event',
		),
		date: ApiDateSchema,
		endDate: ApiDateSchema.nullable().describe('Last day of a multi-day all-day event'),
		startTime: z.string().nullable().describe('HH:MM in the family time zone'),
		endTime: z.string().nullable().describe('HH:MM in the family time zone'),
		memberIds: z.array(MemberId).describe('Who is involved; empty means the whole family'),
		location: z.string().nullable(),
		notes: z.string().nullable(),
		recurrence: RecurrenceSchema.nullable().describe('How it repeats; null for a one-off event'),
		rrule: z
			.string()
			.nullable()
			.describe('The repeat rule (RFC 5545) when it is more than `recurrence` can say'),
		reminder: z.number().int().nullable().describe('Minutes before the start; null for none'),
		tags: z.array(z.string()),
		seriesId: EventId.optional().describe(
			'Set on a date moved out of a repeating event: the event it came from',
		),
		recurrenceKey: z
			.string()
			.optional()
			.describe('Set with `seriesId`: the `recurrenceId` the series had for the date it replaced'),
	})
	.meta({ id: 'Event' });

/** The moment an event starts and ends, from its local date and times. */
function whenOf(event: EventDetail, timeZone: string): { start: string; end: string } {
	if (event.allDay) return { start: event.date, end: event.endDate ?? event.date };
	const startTime = event.startTime ?? '00:00';
	const startsAt = epochOf(event.date, startTime, timeZone);
	// An end earlier than the start is the next morning.
	const endDate =
		event.endTime !== null && event.endTime < startTime ? addDays(event.date, 1) : event.date;
	const endsAt = epochOf(endDate, event.endTime ?? startTime, timeZone);
	return { start: apiInstant(startsAt, timeZone), end: apiInstant(endsAt, timeZone) };
}

export const projectEvent = apiOutput(PublicEventSchema, (event: EventDetail, { timeZone }) => ({
	...event,
	...whenOf(event, timeZone),
}));

export const PublicOccurrenceSchema = z
	.object({
		eventId: z
			.string()
			.describe('The event, or `<subscription id>:<uid>:<date>` for one of a subscribed calendar'),
		recurrenceId: Moment.describe(
			'Which occurrence of the event this is: the instant (or day) it was due to start, which stays when the event is moved',
		),
		seriesId: EventId.optional().describe('Set on a date moved out of a repeating event'),
		recurrenceKey: z.string().optional(),
		title: z.string(),
		allDay: z.boolean(),
		start: Moment,
		end: Moment,
		memberIds: z.array(MemberId),
		location: z.string().nullable(),
		recurring: z.boolean(),
		notes: z.string().nullable().describe('Only a subscribed calendar’s events carry notes here'),
		source: z
			.object({
				kind: z.literal('subscription'),
				id: z.string(),
				name: z.string(),
				color: z.string(),
			})
			.nullable()
			.describe('Null for the family’s own events'),
		editable: z.boolean().describe('False for the events of a subscribed calendar'),
		tags: z.array(z.string()),
	})
	.meta({ id: 'Occurrence' });

const projectOccurrences = apiOutput(
	z.array(PublicOccurrenceSchema),
	(occurrences: Occurrence[], { timeZone }) =>
		occurrences.map((o) => {
			const timed = !o.allDay && o.start !== null && o.end !== null;
			const asInstant = (ms: number) => apiInstant(ms, timeZone);
			return {
				eventId: o.eventId,
				recurrenceId: timed && Number.isFinite(Number(o.key)) ? asInstant(Number(o.key)) : o.key,
				...(o.seriesId !== undefined && { seriesId: o.seriesId }),
				...(o.recurrenceKey !== undefined && { recurrenceKey: o.recurrenceKey }),
				title: o.title,
				allDay: o.allDay,
				start: timed ? asInstant(o.start as number) : (o.startDate as string),
				end: timed ? asInstant(o.end as number) : (o.endDate as string),
				memberIds: o.memberIds,
				location: o.location,
				recurring: o.recurring,
				notes: o.notes,
				source: o.source,
				editable: o.editable,
				tags: o.tags,
			};
		}),
);

const projectDeleted = apiOutput(
	z
		.object({
			id: EventId,
			occurrence: Moment.nullable().describe(
				'The `recurrenceId` of the date removed from a repeating event; null when the whole event went',
			),
		})
		.meta({ id: 'EventDeleted' }),
	(result: { id: string; occurrence: string | null }, { timeZone }) => ({
		id: result.id,
		occurrence:
			result.occurrence !== null && Number.isFinite(Number(result.occurrence))
				? apiInstant(Number(result.occurrence), timeZone)
				: result.occurrence,
	}),
);

/** The wording of the fields a caller sends, for the document (the action's own is for a model). */
const OCCURRENCE_DOC =
	'Repeating events: the `recurrenceId` of one occurrence, to affect only that one (an instant, or a day for an all-day event)';

export const api = {
	listOccurrences: defineApi({
		name: 'calendar.listOccurrences',
		method: 'get',
		path: '/occurrences',
		summary:
			'The occurrences of events between two days (inclusive), repeating events expanded, subscribed calendars included. `to` may be at most 62 days after `from`; a longer range is refused with `bad_request`',
		output: projectOccurrences,
	}),
	getEvent: defineApi({
		name: 'calendar.getEvent',
		method: 'get',
		path: '/events/{eventId}',
		summary: 'One event',
		output: projectEvent,
	}),
	createEvent: defineApi({
		name: 'calendar.createEvent',
		method: 'post',
		path: '/events',
		summary: 'Add an event',
		describe: { tags: 'Short labels, at most 5; the family’s existing ones are reused by name' },
		output: projectEvent,
	}),
	patchEvent: defineApi({
		name: 'calendar.patchEvent',
		method: 'patch',
		path: '/events/{eventId}',
		params: { eventId: 'id' },
		summary:
			'Change some details of an event and keep the rest; with `occurrence`, only that date of a repeating event, which becomes an event of its own',
		describe: { occurrence: OCCURRENCE_DOC },
		omit: ['label'],
		output: apiOutput(
			PublicEventSchema,
			(result: { event: EventDetail }, ctx) => projectEvent.project(result.event, ctx) as never,
		),
	}),
	replaceEvent: defineApi({
		name: 'calendar.replaceEvent',
		method: 'put',
		path: '/events/{eventId}',
		params: { eventId: 'id' },
		summary:
			'Replace the whole event with what is sent (every field; null for one left empty). Needs `If-Match`',
		describe: {
			'event.tags': 'Short labels, at most 5; the family’s existing ones are reused by name',
			occurrence: OCCURRENCE_DOC,
			keepRule:
				'True to keep a repeat rule that `recurrence` cannot say (the event shows it as `rrule`); without it an event sent with no `recurrence` stops repeating',
			scope:
				'Repeating events, with `occurrence`: `this` makes only that date an event of its own, `following` ends the series before it and starts a new one',
		},
		output: projectEvent,
	}),
	deleteEvent: defineApi({
		name: 'calendar.deleteEvent',
		method: 'delete',
		path: '/events/{eventId}',
		params: { eventId: 'id' },
		summary: 'Delete an event, or with `occurrence` only that date of a repeating event',
		describe: { occurrence: OCCURRENCE_DOC },
		omit: ['label'],
		output: projectDeleted,
	}),
};
