import { assertActiveMembers, defineAction, FamosError } from '@famos/sdk';
import { addDays, daysBetween, IsoDateSchema, IsoTimeSchema } from '@famos/time';
import { z } from 'zod';
import {
	EventDetailSchema,
	EventIdSchema,
	EventInputSchema,
	MemberIdSchema,
	ReviewLabelSchema,
} from '../contract/index.ts';
import { calendarEdit, eventChanged } from './capabilities.ts';
import { eventAsItIs, eventTitle, loadEvent, WHEN_FIELDS } from './event-state.ts';
import { occurrenceKey, occurrenceScope, resolveOccurrence } from './occurrences.ts';
import { api } from './public.ts';
import { planReminder } from './reminders.ts';
import { EVENT_KIND } from './search.ts';
import {
	type EventRow,
	ensureTags,
	events,
	seriesEndOf,
	skippedAfter,
	tagsOf,
	toDetail,
	toRow,
} from './store.ts';

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
 * Changes some details of an event (the whole series, or one date of it) and keeps the rest: the AI and agents send
 * only what changes, so a repeat rule, reminder or skipped dates they never saw are kept. The
 * output carries the old values, so the change can be taken back.
 */
export const changeEvent = defineAction({
	id: 'calendar.changeEvent',
	expose: api.patchEvent,
	target: ({ id }) => ({
		table: 'calendar_events',
		id,
		liveColumn: 'deleted_at',
		versionColumn: 'version',
	}),
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
		await assertActiveMembers(uow, change.memberIds ?? [], 'memberIds');
		const { timeZone } = await uow.family.settings();
		const series = toDetail(row);
		const split = Boolean(occurrence && row.rrule);
		const { was, current } = eventAsItIs(row, split ? occurrence : undefined);
		const merged = { ...current };
		const before: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(change) as [keyof EventChange, unknown][]) {
			if (value === undefined) continue;
			// A start time cannot be null: an all-day event has none, so the undo leaves it out.
			if (key !== 'startTime' || current[key] !== undefined) before[key] = current[key] ?? null;
			merged[key] = value === null ? undefined : value;
		}
		// Going back from all-day to timed (or the other way) needs the times the other form held.
		if (change.allDay !== undefined && change.allDay !== was.allDay) {
			if (was.startTime) before.startTime = was.startTime;
			if (was.endTime) before.endTime = was.endTime;
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
			const span = daysBetween(was.date, was.endDate);
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
				series_id: id,
				recurrence_key: occurrence as string,
				created_by: row.created_by,
				source_kind: null,
				source_id: null,
				created_at: now,
				updated_at: now,
				deleted_at: null,
				version: 0,
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
			const schedule = (r: EventRow) => planReminder(uow, r, now);
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
		if (was.rrule && !was.recurrence) {
			next.rrule = row.rrule;
			next.series_end = seriesEndOf(next);
		}
		const now = uow.clock.now();
		await events(uow.db)
			.updateTable('calendar_events')
			.set({ ...next, exdates: skippedAfter(row, next), updated_at: now })
			.where('id', '=', id)
			.execute();
		const updated = await loadEvent(uow, id);
		await ensureTags(uow.db, tagsOf(updated.tags), now);
		await planReminder(uow, updated, now);
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
	input: z.object({
		id: EventIdSchema,
		occurrence: z.string(),
		splitId: EventIdSchema.optional().describe(
			'The moved date, for one moved before dates kept their link to the series',
		),
	}),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: calendarEdit.id },
	async run(uow, { id, occurrence, splitId }) {
		const now = uow.clock.now();
		// The moved date is the one linked to this series at that occurrence.
		const linked = await events(uow.db)
			.selectFrom('calendar_events')
			.select('id')
			.where('series_id', '=', id)
			.where('recurrence_key', '=', occurrence)
			.where('deleted_at', 'is', null)
			.execute();
		const moved = new Set(linked.map((m) => m.id));
		if (splitId) moved.add(splitId);
		for (const movedId of moved) {
			await events(uow.db)
				.updateTable('calendar_events')
				.set({ deleted_at: now, updated_at: now })
				.where('id', '=', movedId)
				.where('deleted_at', 'is', null)
				.execute();
			await uow.ai.remove(EVENT_KIND, movedId);
			uow.emit(eventChanged, { eventId: movedId, op: 'delete' });
		}
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
		await planReminder(uow, await loadEvent(uow, id), now);
		uow.emit(eventChanged, { eventId: id });
		return { ok: true as const };
	},
});
