import {
	defineAction,
	defineExtension,
	defineRoute,
	FamosError,
	type UnitOfWork,
} from '@famos/sdk';
import { IsoDateSchema, IsoTimeSchema, todayIn, zoned } from '@famos/time';
import { z } from 'zod';
import {
	EventDetailSchema,
	EventIdSchema,
	EventInputSchema,
	MemberIdSchema,
	OccurrenceSchema,
	RangeQuerySchema,
	ReviewLabelSchema,
} from '../contract/index.ts';
import {
	calendarEdit,
	calendarManage,
	calendarView,
	eventChanged,
	subscriptionChanged,
	tagChanged,
} from './capabilities.ts';
import { createFeed, feedRoute, listFeeds, revokeFeed, touchFeed } from './feeds.ts';
import { reminderKind, remindJob, scheduleReminder } from './reminders.ts';
import { EVENT_KIND, searchIndex } from './search.ts';
import {
	ensureTags,
	eventExists,
	events,
	migrations,
	occurrencesBetween,
	sortOccurrences,
	tagsOf,
	toDetail,
	toRow,
} from './store.ts';
import {
	addSubscription,
	externalOccurrencesBetween,
	listSubscriptions,
	refreshJob,
	refreshSubscription,
	removeSubscription,
	updateSubscription,
} from './subscriptions.ts';
import { deleteTag, listTags, updateTag } from './tags.ts';
import { whenOf } from './when.ts';

/**
 * Calendar extension: family events with members, all-day days and recurrence; secret ICS feeds
 * out and read-only subscriptions in.
 */
export {
	calendarEdit,
	calendarManage,
	calendarView,
	eventChanged,
	subscriptionChanged,
	tagChanged,
};

async function assertMembers(uow: UnitOfWork, ids: readonly string[]) {
	if (ids.length === 0) return;
	const active = new Set((await uow.family.members()).map((m) => m.id));
	const missing = ids.filter((id) => !active.has(id));
	if (missing.length) throw new FamosError('bad_request', `Unknown members: ${missing.join(', ')}`);
}

async function loadEvent(uow: UnitOfWork, id: string) {
	const row = await events(uow.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Event not found');
	return row;
}

export const createEvent = defineAction({
	id: 'calendar.createEvent',
	title: 'Add an event to the family calendar',
	draftTitle: 'calendar:draft_title_create_event',
	input: EventInputSchema,
	output: EventDetailSchema,
	approval: { unless: calendarEdit.id },
	undo: (event) => ({ actionId: 'calendar.deleteEvent', input: { id: event.id } }),
	alreadyThere: async (ctx, input) =>
		eventExists(ctx.db, input, (await ctx.family.settings()).timeZone),
	// Over once its last day has passed; a repeating event still comes again, so it never expires.
	draftDate: (input) => (input.recurrence ? undefined : (input.endDate ?? input.date)),
	ai: {
		description:
			'Adds an event to the family calendar: appointments, school trips, classes, visits, deliveries, services. Use for anything that happens at a date (and usually a time).',
		guidance:
			'Use the family time zone. Resolve relative dates ("Friday", "tomorrow") from today\'s date. Set allDay only when no time is given. List the members involved; leave empty for the whole family. Use existing family tags when they fit (school, health, car…); at most 2.',
	},
	async run(uow, input) {
		await assertMembers(uow, input.memberIds ?? []);
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const id = uow.ids.next('cal_event');
		const row = {
			id,
			...toRow(input, timeZone),
			exdates: null,
			created_by: uow.actor.kind === 'member' ? uow.actor.memberId : null,
			source_kind: null,
			source_id: null,
			created_at: now,
			updated_at: now,
			deleted_at: null,
		};
		await events(uow.db).insertInto('calendar_events').values(row).execute();
		await ensureTags(uow.db, tagsOf(row.tags), now);
		await scheduleReminder((job, payload, o) => uow.enqueue(job, payload, o), row, now);
		await uow.ai.reindex(EVENT_KIND, id);
		uow.emit(eventChanged, { eventId: id });
		return toDetail(row);
	},
});

export const updateEvent = defineAction({
	id: 'calendar.updateEvent',
	title: 'Change an event (whole series)',
	draftTitle: 'calendar:draft_title_update_event',
	input: z.object({ id: EventIdSchema, event: EventInputSchema }),
	output: EventDetailSchema,
	approval: { unless: calendarEdit.id },
	async run(uow, { id, event }) {
		await loadEvent(uow, id);
		await assertMembers(uow, event.memberIds ?? []);
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		await events(uow.db)
			.updateTable('calendar_events')
			.set({ ...toRow(event, timeZone), exdates: null, updated_at: now })
			.where('id', '=', id)
			.execute();
		const updated = await loadEvent(uow, id);
		await ensureTags(uow.db, tagsOf(updated.tags), now);
		// The old reminder job sees the new `updated_at` and does nothing.
		await scheduleReminder((job, payload, o) => uow.enqueue(job, payload, o), updated, now);
		await uow.ai.reindex(EVENT_KIND, id);
		uow.emit(eventChanged, { eventId: id });
		return toDetail(updated);
	},
});

export const deleteEvent = defineAction({
	id: 'calendar.deleteEvent',
	title: 'Delete an event, or one occurrence of a repeating event',
	draftTitle: 'calendar:draft_title_delete_event',
	input: z.object({
		id: EventIdSchema,
		/** Occurrence key (from the occurrence list) to skip just that one. */
		occurrence: z.string().optional(),
		label: ReviewLabelSchema,
	}),
	output: z.object({ ok: z.literal(true), id: z.string(), occurrence: z.string().nullable() }),
	approval: { unless: calendarEdit.id },
	undo: ({ id, occurrence }) => ({
		actionId: 'calendar.restoreEvent',
		input: occurrence ? { id, occurrence } : { id },
	}),
	ai: {
		description:
			'Removes an event from the family calendar. For a repeating event, give `occurrence` to remove only that date; without it the whole series goes. Find the event with calendar.findEvents first.',
	},
	async run(uow, { id, occurrence, label: _label }) {
		const row = await loadEvent(uow, id);
		const now = uow.clock.now();
		if (occurrence && row.rrule) {
			const list: (string | number)[] = row.exdates ? JSON.parse(row.exdates) : [];
			list.push(row.all_day ? occurrence : Number(occurrence));
			await events(uow.db)
				.updateTable('calendar_events')
				.set({ exdates: JSON.stringify(list), updated_at: now })
				.where('id', '=', id)
				.execute();
			await scheduleReminder(
				(job, payload, o) => uow.enqueue(job, payload, o),
				await loadEvent(uow, id),
				now,
			);
		} else {
			await events(uow.db)
				.updateTable('calendar_events')
				.set({ deleted_at: now, updated_at: now })
				.where('id', '=', id)
				.execute();
			await uow.ai.remove(EVENT_KIND, id);
		}
		uow.emit(eventChanged, { eventId: id });
		return { ok: true as const, id, occurrence: occurrence && row.rrule ? occurrence : null };
	},
});

/** Takes back a deletion: the whole event, or one skipped date of a repeating event. */
export const restoreEvent = defineAction({
	id: 'calendar.restoreEvent',
	title: 'Bring back a deleted event, or a skipped date of a repeating event',
	draftTitle: 'calendar:draft_title_restore_event',
	input: z.object({ id: EventIdSchema, occurrence: z.string().optional() }),
	output: EventDetailSchema,
	approval: { unless: calendarEdit.id },
	async run(uow, { id, occurrence }) {
		const row = await events(uow.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Event not found');
		const now = uow.clock.now();
		if (occurrence) {
			const list: (string | number)[] = row.exdates ? JSON.parse(row.exdates) : [];
			const kept = list.filter((x) => String(x) !== occurrence);
			await events(uow.db)
				.updateTable('calendar_events')
				.set({ exdates: kept.length ? JSON.stringify(kept) : null, updated_at: now })
				.where('id', '=', id)
				.execute();
		} else if (row.deleted_at !== null) {
			await events(uow.db)
				.updateTable('calendar_events')
				.set({ deleted_at: null, updated_at: now })
				.where('id', '=', id)
				.execute();
			await uow.ai.reindex(EVENT_KIND, id);
		}
		const restored = await loadEvent(uow, id);
		await scheduleReminder((job, payload, o) => uow.enqueue(job, payload, o), restored, now);
		uow.emit(eventChanged, { eventId: id });
		return toDetail(restored);
	},
});

/** What a change may touch; each field left out stays as it is, and null clears it. */
const EventChangeSchema = z.object({
	title: z.string().trim().min(1).max(120).optional().describe('New title'),
	allDay: z.boolean().optional().describe('True for an event without a time of day'),
	date: IsoDateSchema.optional().describe('New start date, YYYY-MM-DD, in the family time zone'),
	endDate: IsoDateSchema.nullable().optional().describe('Last day of a multi-day all-day event'),
	startTime: IsoTimeSchema.optional().describe('New start time HH:MM'),
	endTime: IsoTimeSchema.nullable()
		.optional()
		.describe('New end time HH:MM; null for one hour after the start'),
	memberIds: z
		.array(MemberIdSchema)
		.optional()
		.describe('Who is involved now (the full list); empty means the whole family'),
	location: z.string().trim().max(200).nullable().optional(),
	notes: z.string().trim().max(2000).nullable().optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(3).optional(),
});
type EventChange = z.infer<typeof EventChangeSchema>;

/**
 * Changes some details of an event (the whole series) and keeps the rest: the AI and agents send
 * only what changes, so a repeat rule, reminder or skipped dates they never saw are kept. The
 * output carries the old values, so the change can be taken back.
 */
export const changeEvent = defineAction({
	id: 'calendar.changeEvent',
	title: 'Change some details of an event (whole series)',
	draftTitle: 'calendar:draft_title_change_event',
	input: EventChangeSchema.extend({ id: EventIdSchema, label: ReviewLabelSchema }),
	// The old values of what changed, keyed like the input (for undo).
	output: z.object({ event: EventDetailSchema, before: z.record(z.string(), z.unknown()) }),
	approval: { unless: calendarEdit.id },
	undo: ({ event, before }) => ({
		actionId: 'calendar.changeEvent',
		input: { id: event.id, ...before },
	}),
	// Moving an event to a day that has passed means nothing; other changes do not expire.
	draftDate: (input) => input.endDate ?? input.date,
	ai: {
		description:
			'Changes an existing family event: its time, date, place, title, notes, tags or who goes. Send only the fields that change. Find the event with calendar.findEvents first; never add a second event for the same thing.',
		guidance:
			'Use the family time zone and resolve relative dates from today. For a repeating event this changes every date; to drop one date use calendar.deleteEvent with its occurrence.',
	},
	async run(uow, { id, label: _label, ...change }) {
		const row = await loadEvent(uow, id);
		await assertMembers(uow, change.memberIds ?? []);
		const { timeZone } = await uow.family.settings();
		const was = toDetail(row);
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
		const merged = { ...current };
		const before: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(change) as [keyof EventChange, unknown][]) {
			if (value === undefined) continue;
			before[key] = current[key] ?? null;
			merged[key] = value === null ? undefined : value;
		}
		// A new start without a new end keeps the event as long as it was.
		if (
			change.startTime !== undefined &&
			change.endTime === undefined &&
			was.startTime &&
			was.endTime &&
			was.endTime > was.startTime
		) {
			const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
			const end = Math.min(
				minutes(change.startTime) + minutes(was.endTime) - minutes(was.startTime),
				23 * 60 + 59,
			);
			before.endTime = was.endTime;
			merged.endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
		}
		if (Object.keys(before).length === 0) return { event: was, before };
		const parsed = EventInputSchema.safeParse(merged);
		if (!parsed.success)
			throw new FamosError('bad_request', parsed.error.issues[0]?.message ?? 'Invalid change');
		const next = toRow(parsed.data, timeZone);
		// A repeat rule outside the editable presets is kept as it was.
		if (was.rrule) next.rrule = row.rrule;
		const moved = ['date', 'startTime', 'allDay'].some((k) => k in before);
		const now = uow.clock.now();
		await events(uow.db)
			.updateTable('calendar_events')
			.set({ ...next, exdates: moved ? null : row.exdates, updated_at: now })
			.where('id', '=', id)
			.execute();
		const updated = await loadEvent(uow, id);
		await ensureTags(uow.db, tagsOf(updated.tags), now);
		await scheduleReminder((job, payload, o) => uow.enqueue(job, payload, o), updated, now);
		await uow.ai.reindex(EVENT_KIND, id);
		uow.emit(eventChanged, { eventId: id });
		return { event: toDetail(updated), before };
	},
});

const MAX_RANGE_DAYS = 62;

const MAX_FOUND = 60;

/** `HH:MM` of an instant in the family time zone. */
const clock = (ms: number, timeZone: string) =>
	zoned(ms, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

export const findEvents = defineAction({
	id: 'calendar.findEvents',
	title: 'Find events in a date range, for the AI',
	input: z.object({
		from: IsoDateSchema.describe('First day, YYYY-MM-DD'),
		to: IsoDateSchema.describe('Last day (inclusive), YYYY-MM-DD; at most 62 days after `from`'),
		tag: z.string().trim().max(40).optional().describe('Only events with this tag, e.g. "school"'),
	}),
	output: z.object({
		events: z.array(
			z.object({
				id: z
					.string()
					.nullable()
					.describe('The event, for changing or deleting it; null for subscribed calendars'),
				occurrence: z
					.string()
					.describe('This date of a repeating event, for deleting only that one'),
				title: z.string(),
				date: z.string(),
				endDate: z.string().nullable(),
				time: z.string().nullable().describe('HH:MM-HH:MM local time; null for all-day events'),
				memberIds: z.array(z.string()).describe('Empty means the whole family'),
				location: z.string().nullable(),
				tags: z.array(z.string()),
				recurring: z.boolean(),
				external: z.boolean().describe('From a subscribed calendar'),
				when: z
					.enum(['past', 'now', 'upcoming'])
					.describe(
						'past: already over; now: happening now (or today, all day); upcoming: still ahead',
					),
			}),
		),
		truncated: z.boolean(),
	}),
	readOnly: true,
	requires: calendarView.id,
	ai: {
		description:
			'Finds what is on the family calendar between two dates (inclusive), repeating events expanded and subscribed calendars included, in time order. Each event says whether it is past, happening now or upcoming. Use it for "what is on this week / on Saturday / is the dentist booked" questions.',
		guidance:
			'Resolve relative dates ("this week", "tomorrow") from today in the family time zone. For what is coming up (also "this week"), start at today. Never present an event whose when is past as coming up.',
	},
	async run(uow, { from, to, tag }) {
		if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS || to < from) {
			throw new FamosError('bad_request', `The range may span at most ${MAX_RANGE_DAYS} days`);
		}
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const today = todayIn(timeZone, now);
		const [own, external] = await Promise.all([
			occurrencesBetween(uow.db, from, to, timeZone),
			externalOccurrencesBetween(uow.db, from, to, timeZone),
		]);
		const wanted = tag?.toLocaleLowerCase();
		const all = sortOccurrences([...own, ...external], timeZone).filter(
			(o) => !wanted || o.tags.some((t) => t.toLocaleLowerCase() === wanted),
		);
		return {
			events: all.slice(0, MAX_FOUND).map((o) => ({
				id: o.source === null ? o.eventId : null,
				occurrence: o.key,
				title: o.title,
				date: o.allDay
					? (o.startDate as string)
					: zoned(o.start as number, timeZone)
							.toPlainDate()
							.toString(),
				endDate: o.allDay && o.endDate && o.endDate !== o.startDate ? o.endDate : null,
				time:
					!o.allDay && o.start !== null
						? `${clock(o.start, timeZone)}${o.end !== null ? `-${clock(o.end, timeZone)}` : ''}`
						: null,
				memberIds: o.memberIds,
				location: o.location,
				tags: o.tags,
				recurring: o.recurring,
				external: o.source !== null,
				when: whenOf(o, now, today),
			})),
			truncated: all.length > MAX_FOUND,
		};
	},
});

const listOccurrences = defineRoute({
	method: 'get',
	path: '/occurrences',
	operationId: 'calendar.listOccurrences',
	summary:
		'Event occurrences between two dates (inclusive), recurring events expanded; subscriptions included',
	requires: calendarView.id,
	query: RangeQuerySchema,
	response: z.array(OccurrenceSchema),
	async handle(ctx, { query }) {
		if ((Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 > MAX_RANGE_DAYS) {
			throw new FamosError('bad_request', `The range may span at most ${MAX_RANGE_DAYS} days`);
		}
		const { timeZone } = await ctx.family.settings();
		const [own, external] = await Promise.all([
			occurrencesBetween(ctx.db, query.from, query.to, timeZone),
			externalOccurrencesBetween(ctx.db, query.from, query.to, timeZone),
		]);
		return sortOccurrences([...own, ...external], timeZone);
	},
});

const getEvent = defineRoute({
	method: 'get',
	path: '/events/{eventId}',
	operationId: 'calendar.getEvent',
	summary: 'An event as an editable form',
	requires: calendarView.id,
	params: z.object({ eventId: EventIdSchema }),
	response: EventDetailSchema,
	async handle(ctx, { params }) {
		const row = await events(ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', params.eventId)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Event not found');
		return toDetail(row);
	},
});

export default defineExtension({
	id: 'calendar',
	migrations,
	ai: { index: searchIndex },
	actions: [
		findEvents,
		createEvent,
		updateEvent,
		changeEvent,
		deleteEvent,
		restoreEvent,
		updateTag,
		deleteTag,
		createFeed,
		revokeFeed,
		touchFeed,
		addSubscription,
		updateSubscription,
		removeSubscription,
		refreshSubscription,
	],
	routes: [listOccurrences, getEvent, listTags, listFeeds, feedRoute, listSubscriptions],
	events: [eventChanged, subscriptionChanged, tagChanged],
	capabilities: [calendarView, calendarEdit, calendarManage],
	notifications: [reminderKind],
	jobs: [remindJob, refreshJob],
});
