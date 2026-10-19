import {
	type DuplicateContext,
	defineAction,
	defineExtension,
	defineRoute,
	digestNotes,
	FamosError,
	searchFinds,
	storedAsWhole,
	type UnitOfWork,
} from '@famos/sdk';
import {
	addDays,
	compareDates,
	formatDate,
	fromRRule,
	IsoDateSchema,
	IsoTimeSchema,
	isValidDate,
	todayIn,
	toRRule,
	zoned,
} from '@famos/time';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import {
	defaultReminder,
	type EventDetail,
	EventDetailSchema,
	EventIdSchema,
	EventInputSchema,
	EventReplaceSchema,
	eventFromReplace,
	MemberIdSchema,
	OccurrenceSchema,
	RangeQuerySchema,
	ReviewLabelSchema,
	tagKey,
} from '../contract/index.ts';
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import {
	calendarEdit,
	calendarManage,
	calendarView,
	eventChanged,
	subscriptionChanged,
	tagChanged,
} from './capabilities.ts';
import { aiContextEvents } from './context.ts';
import { calendarDigest } from './digest.ts';
import { createFeed, endFeedsOf, feedRoute, listFeeds, revokeFeed, touchFeed } from './feeds.ts';
import { movedEvent } from './moved.ts';
import { reminderKind, remindJob, scheduleReminder } from './reminders.ts';
import { EVENT_KIND, searchIndex } from './search.ts';
import {
	type EventRow,
	effectiveReminder,
	ensureTags,
	eventExists,
	events,
	expandRow,
	migrations,
	occurrencesBetween,
	replacementRow,
	skippedAfter,
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
import { aiContext, deleteTag, listTags, updateTag } from './tags.ts';
import { calendarKinds } from './understand.ts';
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

/**
 * One date of a repeating event as an event of its own: the series' details at that date (a
 * multi-day all-day event keeps its length, a timed one its start and end). Throws when the key
 * is not one of the series' dates.
 */
function occurrenceDetail(row: EventRow, series: EventDetail, key: string): EventDetail {
	const notThere = () => new FamosError('bad_request', 'That is not one of the event’s dates');
	const day = row.all_day
		? key
		: Number.isFinite(Number(key))
			? zoned(Number(key), row.time_zone).toPlainDate().toString()
			: '';
	if (!day || !isValidDate(day)) throw notThere();
	if (!expandRow(row, day, day, row.time_zone).some((o) => o.key === key)) throw notThere();
	if (row.all_day) {
		const span = Math.round(
			(Date.parse(series.endDate ?? series.date) - Date.parse(series.date)) / 86_400_000,
		);
		return {
			...series,
			date: key,
			endDate: span > 0 ? addDays(key, span) : null,
			recurrence: null,
			rrule: null,
		};
	}
	const hhmm = (ms: number) => zoned(ms, row.time_zone).toPlainTime().toString().slice(0, 5);
	const start = Number(key);
	return {
		...series,
		date: day,
		startTime: hhmm(start),
		endTime: hhmm(start + ((row.ends_at as number) - (row.starts_at as number))),
		recurrence: null,
		rrule: null,
	};
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The occurrence key of one date of a repeating event. A timed series is keyed by the start
 * (epoch milliseconds), but a model or a person names the date, so a date maps to the one
 * occurrence on that day. Throws a `bad_request` that says what to send instead.
 */
function occurrenceKey(row: EventRow, key: string): string {
	const keys = (day: string) => expandRow(row, day, day, row.time_zone).map((o) => o.key);
	if (!row.all_day && DATE_KEY.test(key)) {
		const found = isValidDate(key) ? keys(key) : [];
		if (found.length === 0)
			throw new FamosError(
				'bad_request',
				`This repeating event does not happen on ${key}. Use the \`occurrence\` that calendar.findEvents shows for the date you mean.`,
			);
		if (found.length > 1)
			throw new FamosError(
				'bad_request',
				`This repeating event happens more than once on ${key}. Use the \`occurrence\` that calendar.findEvents shows for the one you mean.`,
			);
		return String(found[0]);
	}
	const day = row.all_day
		? key
		: Number.isFinite(Number(key))
			? zoned(Number(key), row.time_zone).toPlainDate().toString()
			: '';
	if (!day || !isValidDate(day) || !keys(day).includes(key))
		throw new FamosError(
			'bad_request',
			`'${key}' is not one of the event’s dates. Use the \`occurrence\` that calendar.findEvents shows, or the date of that occurrence.`,
		);
	return key;
}

/** `resolveNames` of the actions that take an `occurrence`: stores the key, never a date. */
const resolveOccurrence = async <T extends { id: string; occurrence?: string | undefined }>(
	ctx: DuplicateContext,
	input: T,
): Promise<T> => {
	if (!input.occurrence) return input;
	const row = await events(ctx.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', input.id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	// A missing event or a single event is the action's own business.
	if (!row?.rrule) return input;
	return { ...input, occurrence: occurrenceKey(row, input.occurrence) };
};

/** `scopeNote` of the actions that take an `occurrence`: the one date a change is limited to. */
const occurrenceScope = async (
	ctx: DuplicateContext,
	input: { id: string; occurrence?: string | undefined },
): Promise<{ key: string; date: string } | null> => {
	if (!input.occurrence) return null;
	const row = await events(ctx.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', input.id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	// On a single event the occurrence means nothing: the change is to the whole of it.
	if (!row?.rrule) return null;
	const date = DATE_KEY.test(input.occurrence)
		? input.occurrence
		: row.all_day
			? input.occurrence
			: Number.isFinite(Number(input.occurrence))
				? zoned(Number(input.occurrence), row.time_zone).toPlainDate().toString()
				: '';
	return isValidDate(date) ? { key: 'calendar:title_one_date', date } : null;
};

/** The title of a live event, for the runner's check that an AI's label names the right one. */
const eventTitle = async (ctx: DuplicateContext, { id }: { id: string }) =>
	(
		await events(ctx.db)
			.selectFrom('calendar_events')
			.select('title')
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst()
	)?.title ?? null;

export const createEvent = defineAction({
	id: 'calendar.createEvent',
	title: 'Add an event to the family calendar',
	draftTitle: 'calendar:draft_title_create_event',
	input: EventInputSchema,
	output: EventDetailSchema,
	approval: { unless: calendarEdit.id },
	undo: (event) => ({ actionId: 'calendar.deleteEvent', input: { id: event.id } }),
	alreadyThere: async (ctx, input) => eventExists(ctx.db, input, await ctx.family.settings()),
	// A message that an event moved arrives as a new event: the reviewer may move the one there.
	instead: async (ctx, input) => movedEvent(ctx.db, input, await ctx.family.settings()),
	// Over once its last day has passed; a repeating event still comes again, so it never expires.
	draftDate: (input) => (input.recurrence ? undefined : (input.endDate ?? input.date)),
	ai: {
		description:
			'Adds an event to the family calendar: appointments, school trips, classes, visits, deliveries, services. Use for anything that happens at a date (and usually a time).',
		guidance:
			'Use the family time zone. Resolve relative dates ("Friday", "tomorrow") from today\'s date. Set allDay only when no time is given. List the members involved; leave empty for the whole family. Use one of the existing family tags when it fits (they are listed when known); add a new short tag only when none does. At most 2. When the person, pet or thing it is for is not a member, name them in the title.',
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

const storedAsWholeEvent = storedAsWhole(EventInputSchema, 'event');
function storedEventReplace(input: unknown): unknown {
	const event = (input as { event?: { reminder?: unknown; allDay?: unknown } } | null)?.event;
	const filled = storedAsWholeEvent(input);
	if (!event || typeof event !== 'object' || event.reminder !== undefined) return filled;
	const whole = filled as { event: Record<string, unknown> };
	return { ...whole, event: { ...whole.event, reminder: defaultReminder(event.allDay === true) } };
}

export const updateEvent = defineAction({
	id: 'calendar.updateEvent',
	target: ({ id }) => ({ table: 'calendar_events', id, liveColumn: 'deleted_at' }),
	title: 'Change an event',
	description:
		'Replaces the whole event with what the form saved: send every field, null for one left empty. To change some fields and keep the rest, use calendar.changeEvent.',
	draftTitle: 'calendar:draft_title_update_event',
	input: z.object({
		id: EventIdSchema,
		event: EventReplaceSchema,
		occurrence: z
			.string()
			.optional()
			.describe(
				'Repeating events, with `scope`: the `occurrence` key from calendar.findEvents, or the date (YYYY-MM-DD), of the date the form was opened on',
			),
		scope: z
			.enum(['this', 'following'])
			.optional()
			.describe(
				'Repeating events, with `occurrence`: `this` makes just that date its own one-off event with the form and skips it in the series; `following` ends the series before that date and starts a new one from the form. Leave out to replace the whole series',
			),
		keepRule: z
			.boolean()
			.optional()
			.describe(
				'True when the form left a repeat rule outside the presets as it was: the rule is kept. Without it, an event with no `recurrence` does not repeat',
			),
	}),
	// Waiting from when a field left out meant empty, and a reminder left out the default one.
	storedInput: storedEventReplace,
	output: EventDetailSchema,
	approval: { unless: calendarEdit.id },
	targetTitle: eventTitle,
	// The form sends the whole event: what differs from the event as it is now is what changes,
	// so the card lists only those fields, "old → new".
	async currentValues(ctx, { id, event, keepRule }) {
		const row = await events(ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) return null;
		const { timeZone } = await ctx.family.settings();
		const { current } = eventAsItIs(row, undefined);
		const keys = eventFieldsChanged(
			row,
			replacementRow(row, eventFromReplace(event), timeZone, keepRule),
		);
		const now: Record<string, unknown> = { ...current, reminder: effectiveReminder(row) };
		return Object.fromEntries(keys.map((k) => [k, now[k] ?? null]));
	},
	async run(uow, { id, event: whole, occurrence: rawOccurrence, scope, keepRule }) {
		const row = await loadEvent(uow, id);
		const event = eventFromReplace(whole);
		await assertMembers(uow, event.memberIds ?? []);
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		if (scope && rawOccurrence && row.rrule) {
			const occurrence = occurrenceKey(row, rawOccurrence);
			const day = row.all_day
				? occurrence
				: zoned(Number(occurrence), row.time_zone).toPlainDate().toString();
			// The first date of a series has nothing before it to keep: "from here on" is all of it.
			if (scope === 'this' || compareDates(day, toDetail(row).date) > 0) {
				const { recurrence: _repeat, ...single } = event;
				const created = {
					id: uow.ids.next('cal_event'),
					...toRow(scope === 'this' ? single : event, timeZone),
					exdates: null,
					created_by: row.created_by,
					source_kind: null,
					source_id: null,
					created_at: now,
					updated_at: now,
					deleted_at: null,
				};
				await events(uow.db).insertInto('calendar_events').values(created).execute();
				if (scope === 'this') {
					const skipped: (string | number)[] = row.exdates ? JSON.parse(row.exdates) : [];
					skipped.push(row.all_day ? occurrence : Number(occurrence));
					await events(uow.db)
						.updateTable('calendar_events')
						.set({ exdates: JSON.stringify(skipped), updated_at: now })
						.where('id', '=', id)
						.execute();
				} else {
					const rule = fromRRule(row.rrule, row.time_zone);
					if (!rule)
						throw new FamosError(
							'bad_request',
							'This repeat rule cannot be split; change the whole series instead.',
						);
					const last = addDays(day, -1);
					const until = rule.until && compareDates(rule.until, last) < 0 ? rule.until : last;
					const kept = (row.exdates ? (JSON.parse(row.exdates) as (string | number)[]) : []).filter(
						(e) => (row.all_day ? String(e) < occurrence : Number(e) < Number(occurrence)),
					);
					await events(uow.db)
						.updateTable('calendar_events')
						.set({
							rrule: toRRule({ ...rule, until }, row.all_day ? null : row.time_zone),
							exdates: kept.length ? JSON.stringify(kept) : null,
							updated_at: now,
						})
						.where('id', '=', id)
						.execute();
				}
				await ensureTags(uow.db, tagsOf(created.tags), now);
				const schedule = (r: Parameters<typeof scheduleReminder>[1]) =>
					scheduleReminder((job, payload, o) => uow.enqueue(job, payload, o), r, now);
				await schedule(created);
				await schedule(await loadEvent(uow, id));
				await uow.ai.reindex(EVENT_KIND, created.id);
				uow.emit(eventChanged, { eventId: id });
				uow.emit(eventChanged, { eventId: created.id });
				return toDetail(created);
			}
		}
		const next = replacementRow(row, event, timeZone, keepRule);
		await events(uow.db)
			.updateTable('calendar_events')
			.set({ ...next, exdates: skippedAfter(row, next), updated_at: now })
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
	target: ({ id }) => ({ table: 'calendar_events', id, liveColumn: 'deleted_at' }),
	title: 'Delete an event, or one occurrence of a repeating event',
	draftTitle: 'calendar:draft_title_delete_event',
	input: z.object({
		id: EventIdSchema,
		occurrence: z
			.string()
			.optional()
			.describe(
				'Repeating events: the `occurrence` key from calendar.findEvents, or the date (YYYY-MM-DD) of that occurrence, to remove just that one',
			),
		label: ReviewLabelSchema,
	}),
	output: z.object({ ok: z.literal(true), id: z.string(), occurrence: z.string().nullable() }),
	approval: { unless: calendarEdit.id },
	targetTitle: eventTitle,
	scopeNote: occurrenceScope,
	resolveNames: resolveOccurrence,
	// When the event (or the one date of it) that would go is, so the card says which one.
	async currentValues(ctx, { id, occurrence }) {
		const row = await events(ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) return null;
		const key = occurrence && row.rrule ? occurrenceKey(row, occurrence) : undefined;
		const { current } = eventAsItIs(row, key);
		const keys = [...WHEN_FIELDS, ...(key ? [] : (['recurrence'] as const))];
		return Object.fromEntries(keys.map((k) => [k, current[k] ?? null]));
	},
	undo: ({ id, occurrence }) => ({
		actionId: 'calendar.restoreEvent',
		input: occurrence ? { id, occurrence } : { id },
	}),
	ai: {
		description:
			'Removes an event from the family calendar. For a repeating event, give `occurrence` to remove only that date; without it the whole series goes. Find the event with calendar.findEvents first.',
	},
	async run(uow, { id, occurrence: rawOccurrence, label: _label }) {
		const row = await loadEvent(uow, id);
		// A draft stored before keys were resolved may still hold a date.
		const occurrence =
			rawOccurrence && row.rrule ? occurrenceKey(row, rawOccurrence) : rawOccurrence;
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
 * An event as a change sees it: the event (one date of it, given an occurrence key of a
 * repeating event) and its fields keyed like a change's input.
 */
function eventAsItIs(row: EventRow, occurrence: string | undefined) {
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
const WHEN_FIELDS = ['allDay', 'date', 'endDate', 'startTime', 'endTime'] as const;

/**
 * The fields (keyed like an event's input) in which a stored event and the row a whole new
 * version of it would write differ. Compared as stored, so a form that sends every field back as
 * it was changes nothing here.
 */
function eventFieldsChanged(row: EventRow, next: ReturnType<typeof toRow>): string[] {
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

/**
 * Changes some details of an event (the whole series, or one date of it) and keeps the rest: the AI and agents send
 * only what changes, so a repeat rule, reminder or skipped dates they never saw are kept. The
 * output carries the old values, so the change can be taken back.
 */
export const changeEvent = defineAction({
	id: 'calendar.changeEvent',
	target: ({ id }) => ({ table: 'calendar_events', id, liveColumn: 'deleted_at' }),
	title: 'Change some details of an event',
	draftTitle: 'calendar:draft_title_change_event',
	input: EventChangeSchema.extend({
		id: EventIdSchema,
		occurrence: z
			.string()
			.optional()
			.describe(
				'Repeating events: the `occurrence` key from calendar.findEvents, or the date (YYYY-MM-DD) of that occurrence, to change just that one. That date becomes its own one-off event with the change and is skipped in the series; without it the whole series changes',
			),
		label: ReviewLabelSchema,
	}),
	// The old values of what changed, keyed like the input (for undo). `split` is set when one
	// date of a repeating event became its own event: `event` is then the new one-off event.
	output: z.object({
		event: EventDetailSchema,
		before: z.record(z.string(), z.unknown()),
		split: z.object({ seriesId: z.string(), occurrence: z.string() }).optional(),
	}),
	approval: { unless: calendarEdit.id },
	targetTitle: eventTitle,
	scopeNote: occurrenceScope,
	resolveNames: resolveOccurrence,
	// The event as it is now, for the card's "old → new": a new time is read against the old day
	// and time together, so every field of when it is comes along with any one of them.
	async currentValues(ctx, { id, label: _label, occurrence, ...change }) {
		const row = await events(ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) return null;
		const key = occurrence && row.rrule ? occurrenceKey(row, occurrence) : undefined;
		const { current } = eventAsItIs(row, key);
		const changed = Object.keys(change).filter(
			(k) => change[k as keyof typeof change] !== undefined,
		);
		const when = changed.some((k) => (WHEN_FIELDS as readonly string[]).includes(k));
		const keys = new Set([...changed, ...(when ? WHEN_FIELDS : [])]);
		return Object.fromEntries([...keys].map((k) => [k, current[k] ?? null]));
	},
	// A model sometimes names the event but leaves out what changes, or sends what the event
	// already is (a letter repeating the date of a listed event); such a draft would change
	// nothing, so it is refused.
	async refuseProposal(ctx, { id, label: _label, occurrence, ...change }) {
		const given = Object.entries(change).filter(([, value]) => value !== undefined);
		if (given.length === 0)
			return 'Nothing would change: give the new values (date, startTime, endTime, location…) in their fields.';
		const row = await events(ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) return null;
		const key = occurrence && row.rrule ? occurrenceKey(row, occurrence) : undefined;
		const { current } = eventAsItIs(row, key);
		// Lists (tags, people) in any order; a cleared field is the same as one never set.
		const plain = (value: unknown) =>
			JSON.stringify(Array.isArray(value) ? [...value].sort() : (value ?? null));
		return given.every(([field, value]) => plain(value) === plain(current[field]))
			? `${row.title} is already like that: nothing would change.`
			: null;
	},
	undo: ({ event, before, split }) =>
		split
			? {
					actionId: 'calendar.putOccurrenceBack',
					input: { id: split.seriesId, occurrence: split.occurrence, splitId: event.id },
				}
			: { actionId: 'calendar.changeEvent', input: { id: event.id, ...before } },
	// Moving an event to a day that has passed means nothing; other changes do not expire.
	draftDate: (input) => input.endDate ?? input.date,
	ai: {
		description:
			'Changes an existing family event: its time, date, place, title, notes, tags or who goes. Send only the fields that change. Find the event with calendar.findEvents first; never add a second event for the same thing.',
		guidance:
			'Use the family time zone and resolve relative dates from today. For a repeating event without `occurrence` this changes every date. To move or change just one date of a repeating event, give its `occurrence`; to drop one date use calendar.deleteEvent with its occurrence. Never create a new event to move an existing one.',
	},
	async run(uow, { id, label: _label, occurrence: rawOccurrence, ...change }) {
		const row = await loadEvent(uow, id);
		const occurrence =
			rawOccurrence && row.rrule ? occurrenceKey(row, rawOccurrence) : rawOccurrence;
		await assertMembers(uow, change.memberIds ?? []);
		const { timeZone } = await uow.family.settings();
		const series = toDetail(row);
		const split = Boolean(occurrence && row.rrule);
		const { was, current } = eventAsItIs(row, split ? occurrence : undefined);
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
		// A new first day without a new last day keeps a multi-day event as long as it was.
		if (change.date !== undefined && change.endDate === undefined && was.endDate) {
			const span = Math.round((Date.parse(was.endDate) - Date.parse(was.date)) / 86_400_000);
			before.endDate = was.endDate;
			merged.endDate = addDays(change.date, span);
		}
		if (Object.keys(before).length === 0) return { event: series, before };
		const parsed = EventInputSchema.safeParse(merged);
		if (!parsed.success)
			throw new FamosError('bad_request', parsed.error.issues[0]?.message ?? 'Invalid change');
		const next = toRow(parsed.data, timeZone);
		if (split) {
			const now = uow.clock.now();
			const newId = uow.ids.next('cal_event');
			const created = {
				id: newId,
				...next,
				exdates: null,
				created_by: row.created_by,
				source_kind: null,
				source_id: null,
				created_at: now,
				updated_at: now,
				deleted_at: null,
			};
			await events(uow.db).insertInto('calendar_events').values(created).execute();
			const skipped: (string | number)[] = row.exdates ? JSON.parse(row.exdates) : [];
			skipped.push(row.all_day ? (occurrence as string) : Number(occurrence));
			await events(uow.db)
				.updateTable('calendar_events')
				.set({ exdates: JSON.stringify(skipped), updated_at: now })
				.where('id', '=', id)
				.execute();
			await ensureTags(uow.db, tagsOf(created.tags), now);
			const schedule = (r: Parameters<typeof scheduleReminder>[1]) =>
				scheduleReminder((job, payload, o) => uow.enqueue(job, payload, o), r, now);
			await schedule(created);
			await schedule(await loadEvent(uow, id));
			await uow.ai.reindex(EVENT_KIND, newId);
			uow.emit(eventChanged, { eventId: id });
			uow.emit(eventChanged, { eventId: newId });
			return {
				event: toDetail(created),
				before,
				split: { seriesId: id, occurrence: occurrence as string },
			};
		}
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

/** Takes back moving one date of a repeating event: the one-off event goes, the date returns. */
export const putOccurrenceBack = defineAction({
	id: 'calendar.putOccurrenceBack',
	title: 'Put one date of a repeating event back',
	draftTitle: 'calendar:draft_title_put_occurrence_back',
	input: z.object({ id: EventIdSchema, occurrence: z.string(), splitId: EventIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: calendarEdit.id },
	async run(uow, { id, occurrence, splitId }) {
		const now = uow.clock.now();
		await events(uow.db)
			.updateTable('calendar_events')
			.set({ deleted_at: now, updated_at: now })
			.where('id', '=', splitId)
			.where('deleted_at', 'is', null)
			.execute();
		await uow.ai.remove(EVENT_KIND, splitId);
		const series = await events(uow.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!series) throw new FamosError('not_found', 'Event not found');
		const skipped: (string | number)[] = series.exdates ? JSON.parse(series.exdates) : [];
		const kept = skipped.filter((x) => String(x) !== occurrence);
		await events(uow.db)
			.updateTable('calendar_events')
			.set({ exdates: kept.length ? JSON.stringify(kept) : null, updated_at: now })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(
			(job, payload, o) => uow.enqueue(job, payload, o),
			await loadEvent(uow, id),
			now,
		);
		uow.emit(eventChanged, { eventId: id });
		uow.emit(eventChanged, { eventId: splitId });
		return { ok: true as const };
	},
});

const MAX_RANGE_DAYS = 62;

const MAX_FOUND = 60;

/**
 * The most days (a week) a text search that found nothing lists the other events of: the thing
 * asked about may be among them under other words.
 */
const UNMATCHED_MAX_DAYS = 7;

/** How many days a range covers, both ends included. */
const daysIn = (from: string, to: string) =>
	Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

/** How far past the searched range a search for the next match looks. */
const NEXT_MATCH_DAYS = 366;

/** `HH:MM` of an instant in the family time zone. */
const clock = (ms: number, timeZone: string) =>
	zoned(ms, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

/** One event as `calendar.findEvents` gives it to the model. */
const FoundEventSchema = z.object({
	id: z
		.string()
		.nullable()
		.describe('The event, for changing or deleting it; null for subscribed calendars'),
	occurrence: z
		.string()
		.optional()
		.describe(
			'Repeating events only: the key of this date, for changing or deleting only that one',
		),
	title: z.string(),
	date: z.string(),
	weekday: z
		.string()
		.describe('The weekday of `date`, in English: read it from here, never work it out'),
	endDate: z.string().nullable(),
	time: z.string().nullable().describe('HH:MM-HH:MM local time; null for all-day events'),
	memberIds: z.array(z.string()).describe('Left out means the whole family'),
	location: z.string().nullable(),
	notes: z
		.string()
		.optional()
		.describe("What the event's notes say (what to bring, details); left out when it has none"),
	tags: z.array(z.string()),
	recurring: z.literal(true).optional().describe('Only on repeating events'),
	external: z.literal(true).optional().describe('Only on events from a subscribed calendar'),
	when: z
		.enum(['past', 'now', 'upcoming'])
		.optional()
		.describe(
			'Only for today and what is on now. past: already over; now: happening now (or today, all day); upcoming: still ahead. Other days are before or after today by their date',
		),
});

export const findEvents = defineAction({
	id: 'calendar.findEvents',
	title: 'Find events in a date range, for the AI',
	input: z.object({
		from: IsoDateSchema.optional().describe(
			'First day, YYYY-MM-DD; required unless `text` is given (then it defaults to today). Without `to` and `text` it means that one day',
		),
		to: IsoDateSchema.optional().describe(
			'Last day (inclusive), YYYY-MM-DD; at most 62 days after `from`; with `text` it defaults to 62 days after `from`',
		),
		text: z
			.string()
			.trim()
			.max(80)
			.optional()
			.describe(
				'Only events whose title or place contains this text or a form of its words ("swimming" also finds "Swim training"), e.g. "swimming". Without `from` and `to` it searches from today on',
			),
		members: z
			.array(MemberIdSchema)
			.max(10)
			.optional()
			.describe(
				'Leave it out (the default) for the whole family calendar: overviews and "what is on" questions, also when the person says "give me" or "show me" (that is who gets the answer, not whose events). Only for a question about specific people\'s own events ("my calendar", "what do I have", "am I free", "Noah\'s week"): what involves these people, plus events for the whole family',
			),
		tag: z
			.string()
			.trim()
			.max(40)
			.optional()
			.describe('Only events with this existing family tag; leave out unless a tag was named'),
	}),
	output: z.object({
		events: z.array(FoundEventSchema),
		truncated: z.boolean(),
		forOthers: z
			.array(FoundEventSchema)
			.optional()
			.describe(
				'Only when `members` left a search by `text` empty: the matches in the range for other members',
			),
		unmatched: z
			.array(FoundEventSchema)
			.optional()
			.describe(
				'Only when a search by `text` over at most 7 days found nothing but those days have other events: those events, so the answer can come from them (a "pick-up" may be a "Swimming lesson")',
			),
		note: z.string().optional(),
		nextMatch: z
			.object({
				id: z.string().nullable().describe('The event; null for subscribed calendars'),
				occurrence: z.string().optional(),
				title: z.string(),
				date: z.string(),
			})
			.optional()
			.describe('Only when nothing is in the range: the next event after it (of the same search)'),
	}),
	readOnly: true,
	requires: calendarView.id,
	ai: {
		description:
			'Finds what is on the family calendar between two dates (inclusive), repeating events expanded and subscribed calendars included, in time order. Events of today say whether they are past, happening now or upcoming. To find one thing, give a short `text` from its title. Use it for "what is on this week / on Saturday / is the dentist booked" questions.',
		guidance:
			'Resolve relative dates ("this week", "tomorrow") from today in the family time zone. For what is coming up (also "this week"), start at today. Never present an event whose when is past, or whose date is before today, as coming up.',
	},
	async run(uow, { from: fromDay, to: toDayGiven, tag, text, members }) {
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const today = todayIn(timeZone, now);
		if (!text && !fromDay) {
			const got = Object.entries({ from: fromDay, to: toDayGiven, tag, text, members })
				.filter(([, value]) => value !== undefined)
				.map(([key]) => key);
			throw new FamosError(
				'bad_request',
				`Give \`from\` (alone it means that one day) and optionally \`to\`, or a \`text\` to search for. Received: ${got.length > 0 ? got.join(', ') : 'nothing'}.`,
			);
		}
		// Without a text, `from` alone is that one day.
		const toDay = toDayGiven ?? (text ? undefined : fromDay);
		// Looking for one thing by name does not need dates: it is searched for from today on.
		const from = fromDay ?? today;
		const to = toDay ?? addDays(from, MAX_RANGE_DAYS);
		if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS || to < from) {
			throw new FamosError('bad_request', `The range may span at most ${MAX_RANGE_DAYS} days`);
		}
		const wanted = tag?.toLocaleLowerCase();
		const needle = text?.toLocaleLowerCase();
		const notes: string[] = [];
		// A tag nobody uses finds nothing; say so, so the model tries a text filter instead.
		if (tag) {
			const known = await events(uow.db)
				.selectFrom('calendar_tags')
				.select('key')
				.where('key', '=', tagKey(tag))
				.executeTakeFirst();
			if (!known) notes.push(`There is no family tag "${tag}"; use \`text\` to search by subject.`);
		}
		const between = async (a: string, b: string, byMembers = true, bySearch = true) => {
			const [own, external] = await Promise.all([
				occurrencesBetween(uow.db, a, b, timeZone, { withNotes: true }),
				externalOccurrencesBetween(uow.db, a, b, timeZone),
			]);
			return sortOccurrences([...own, ...external], timeZone)
				.filter(
					(o) =>
						!byMembers ||
						!members?.length ||
						o.memberIds.length === 0 ||
						o.memberIds.some((m) => (members as readonly string[]).includes(m)),
				)
				.filter((o) => !wanted || o.tags.some((t) => t.toLocaleLowerCase() === wanted))
				.filter(
					(o) =>
						!bySearch ||
						!needle ||
						searchFinds(needle, o.title) ||
						searchFinds(needle, o.location ?? ''),
				);
		};
		const all = await between(from, to);
		// What the person filter left out is told, so an agent that filtered when the question was
		// about the whole family learns there is more instead of answering "nothing". A search by
		// name that the filter left empty also shows the other members' matches: "the swimming"
		// may be anyone's, and only the person's words say whether it had to be theirs.
		type Found = (typeof all)[number];
		let forOthers: Found[] = [];
		if (members?.length) {
			const unfiltered = await between(from, to, false);
			const others = unfiltered.length - all.length;
			if (all.length === 0 && needle && others > 0) {
				forOthers = unfiltered.slice(0, MAX_FOUND);
				notes.push(
					'Nothing in this range for the members asked about; the matches in it for other members are in forOthers.',
				);
			} else if (others > 0)
				notes.push(
					`${others} more ${others === 1 ? 'event matches' : 'events match'} in this range for other members only; leave \`members\` out to see them.`,
				);
		}
		// A search by words that matched nothing does not mean the range is empty: the person's
		// words ("pick up") need not be the title's ("Swimming lesson"). Over a few days, say what
		// else is there; over a longer range that would be the whole calendar and bury the answer,
		// so the note asks for fewer days instead.
		let unmatched: Found[] = [];
		if (all.length === 0 && needle && forOthers.length === 0) {
			const rest = await between(from, to, true, false);
			if (rest.length > 0 && daysIn(from, to) <= UNMATCHED_MAX_DAYS) {
				unmatched = rest.slice(0, MAX_FOUND);
				notes.push(
					`No event's title or place matches "${text}", but ${rest.length === 1 ? 'this other event is' : `these ${rest.length} other events are`} in the range (see unmatched); the one asked about may be among them under other words.`,
				);
			} else if (rest.length > 0) {
				notes.push(
					`No event's title or place matches "${text}". Search a shorter range (a day or a week) to see what else is on.`,
				);
			}
		}
		let nextMatch:
			| { id: string | null; occurrence?: string; title: string; date: string }
			| undefined;
		// Nothing in the range, but the same search finds something later: say what and when,
		// so the answer is "nothing this weekend; the next one is on …" and not "there is none".
		if (all.length === 0) {
			const next = (await between(addDays(to, 1), addDays(to, NEXT_MATCH_DAYS)))[0];
			if (next) {
				const day = next.allDay
					? (next.startDate as string)
					: zoned(next.start as number, timeZone)
							.toPlainDate()
							.toString();
				notes.push(
					`Nothing from ${from} to ${to}. The next ${needle || wanted ? 'match' : 'event'} after it is "${next.title}" on ${day} (see nextMatch).`,
				);
				nextMatch = {
					id: next.source === null ? next.eventId : null,
					...(next.recurring && { occurrence: next.key }),
					title: next.title,
					date: day,
				};
			}
		}
		if (all.length > MAX_FOUND)
			notes.push(
				`Only the first ${MAX_FOUND} of ${all.length} events are shown. Narrow the query (a shorter date range or a text filter) to see the rest.`,
			);
		const view = (o: Found) => {
			const date = o.allDay
				? (o.startDate as string)
				: zoned(o.start as number, timeZone)
						.toPlainDate()
						.toString();
			const when = whenOf(o, now, today);
			const notes = digestNotes(o.notes);
			return {
				id: o.source === null ? o.eventId : null,
				...(o.recurring && { occurrence: o.key }),
				title: o.title,
				date,
				// Models work weekdays out wrongly from a date; code gives it.
				weekday: formatDate(date, 'en', { weekday: 'long' }),
				endDate: o.allDay && o.endDate && o.endDate !== o.startDate ? o.endDate : null,
				time:
					!o.allDay && o.start !== null
						? `${clock(o.start, timeZone)}${o.end !== null ? `-${clock(o.end, timeZone)}` : ''}`
						: null,
				memberIds: o.memberIds,
				location: o.location,
				// Without them a model says an event "has no notes" about what to bring.
				...(notes && { notes }),
				tags: o.tags,
				// Flags only when set: most events are neither, and every field costs tokens.
				...(o.recurring && { recurring: true as const }),
				...(o.source !== null && { external: true as const }),
				// Other days are before or after today by their date; the model needs this only
				// to tell what is over from what is still to come today.
				...((date === today || when === 'now') && { when }),
			};
		};
		return {
			events: all.slice(0, MAX_FOUND).map(view),
			truncated: all.length > MAX_FOUND,
			...(forOthers.length > 0 && { forOthers: forOthers.map(view) }),
			...(unmatched.length > 0 && { unmatched: unmatched.map(view) }),
			...(nextMatch && { nextMatch }),
			...(notes.length > 0 && { note: notes.join(' ') }),
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
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { index: searchIndex, context: [aiContext.id, aiContextEvents.id], kinds: calendarKinds },
	actions: [
		findEvents,
		calendarDigest,
		createEvent,
		updateEvent,
		changeEvent,
		deleteEvent,
		restoreEvent,
		putOccurrenceBack,
		updateTag,
		deleteTag,
		aiContext,
		aiContextEvents,
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
	endCredentials: endFeedsOf,
});
