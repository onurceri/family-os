import { assertActiveMembers, defineAction, FamosError, selfOf, storedAsWhole } from '@famos/sdk';
import { addDays, compareDates, fromRRule, toRRule, zoned } from '@famos/time';
import { z } from 'zod';
import {
	defaultReminder,
	EventDetailSchema,
	EventIdSchema,
	EventInputSchema,
	EventReplaceSchema,
	eventFromReplace,
	ReviewLabelSchema,
} from '../contract/index.ts';
import { calendarEdit, eventChanged } from './capabilities.ts';
import {
	eventAsItIs,
	eventFieldsChanged,
	eventTitle,
	loadEvent,
	WHEN_FIELDS,
} from './event-state.ts';
import { movedEvent } from './moved.ts';
import { occurrenceKey, occurrenceScope, resolveOccurrence } from './occurrences.ts';
import { api } from './public.ts';
import { planReminder } from './reminders.ts';
import { EVENT_KIND } from './search.ts';
import {
	type EventRow,
	effectiveReminder,
	ensureTags,
	eventExists,
	events,
	replacementRow,
	seriesEndOf,
	skippedAfter,
	tagsOf,
	toDetail,
	toRow,
} from './store.ts';

export const createEvent = defineAction({
	id: 'calendar.createEvent',
	expose: api.createEvent,
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
		await assertActiveMembers(uow, input.memberIds ?? [], 'memberIds');
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const id = uow.ids.next('cal_event');
		const row = {
			id,
			...toRow(input, timeZone),
			exdates: null,
			series_id: null,
			recurrence_key: null,
			created_by: selfOf(uow.actor),
			source_kind: null,
			source_id: null,
			created_at: now,
			updated_at: now,
			deleted_at: null,
			version: 0,
		};
		await events(uow.db).insertInto('calendar_events').values(row).execute();
		await ensureTags(uow.db, tagsOf(row.tags), now);
		await planReminder(uow, row, now);
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
	expose: api.replaceEvent,
	target: ({ id }) => ({
		table: 'calendar_events',
		id,
		liveColumn: 'deleted_at',
		versionColumn: 'version',
	}),
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
		await assertActiveMembers(uow, event.memberIds ?? [], 'memberIds');
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
					series_id: scope === 'this' ? id : null,
					recurrence_key: scope === 'this' ? occurrence : null,
					created_by: row.created_by,
					source_kind: null,
					source_id: null,
					created_at: now,
					updated_at: now,
					deleted_at: null,
					version: 0,
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
					const shortened = toRRule({ ...rule, until }, row.all_day ? null : row.time_zone);
					const kept = (row.exdates ? (JSON.parse(row.exdates) as (string | number)[]) : []).filter(
						(e) => (row.all_day ? String(e) < occurrence : Number(e) < Number(occurrence)),
					);
					await events(uow.db)
						.updateTable('calendar_events')
						.set({
							rrule: shortened,
							series_end: seriesEndOf({ ...row, rrule: shortened }),
							exdates: kept.length ? JSON.stringify(kept) : null,
							updated_at: now,
						})
						.where('id', '=', id)
						.execute();
					// Dates moved out of the part that now belongs to the new series go with it.
					const later = (key: string | null) =>
						key !== null && (row.all_day ? key >= occurrence : Number(key) >= Number(occurrence));
					const linked = await events(uow.db)
						.selectFrom('calendar_events')
						.select(['id', 'recurrence_key'])
						.where('series_id', '=', id)
						.execute();
					for (const moved of linked.filter((m) => later(m.recurrence_key))) {
						await events(uow.db)
							.updateTable('calendar_events')
							.set({ series_id: created.id, updated_at: now })
							.where('id', '=', moved.id)
							.execute();
					}
				}
				await ensureTags(uow.db, tagsOf(created.tags), now);
				const schedule = (r: EventRow) => planReminder(uow, r, now);
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
		await planReminder(uow, updated, now);
		await uow.ai.reindex(EVENT_KIND, id);
		uow.emit(eventChanged, { eventId: id });
		return toDetail(updated);
	},
});

export const deleteEvent = defineAction({
	id: 'calendar.deleteEvent',
	expose: api.deleteEvent,
	target: ({ id }) => ({
		table: 'calendar_events',
		id,
		liveColumn: 'deleted_at',
		versionColumn: 'version',
	}),
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
			await planReminder(uow, await loadEvent(uow, id), now);
		} else {
			await events(uow.db)
				.updateTable('calendar_events')
				.set({ deleted_at: now, updated_at: now })
				.where('id', '=', id)
				.execute();
			await uow.ai.remove(EVENT_KIND, id);
			// The dates moved out of a series go with it; the same stamp lets a restore find them.
			const moved = await events(uow.db)
				.selectFrom('calendar_events')
				.select('id')
				.where('series_id', '=', id)
				.where('deleted_at', 'is', null)
				.execute();
			for (const m of moved) {
				await events(uow.db)
					.updateTable('calendar_events')
					.set({ deleted_at: now, updated_at: now })
					.where('id', '=', m.id)
					.execute();
				await uow.ai.remove(EVENT_KIND, m.id);
				uow.emit(eventChanged, { eventId: m.id, op: 'delete' });
			}
		}
		// Skipping one date of a series changes the series; removing the event takes it away.
		uow.emit(eventChanged, {
			eventId: id,
			op: occurrence && row.rrule ? 'upsert' : 'delete',
		});
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
			// The dates that went with the series (deleted at the same moment) come back with it.
			const moved = await events(uow.db)
				.selectFrom('calendar_events')
				.select('id')
				.where('series_id', '=', id)
				.where('deleted_at', '=', row.deleted_at)
				.execute();
			for (const m of moved) {
				await events(uow.db)
					.updateTable('calendar_events')
					.set({ deleted_at: null, updated_at: now })
					.where('id', '=', m.id)
					.execute();
				await uow.ai.reindex(EVENT_KIND, m.id);
				uow.emit(eventChanged, { eventId: m.id });
			}
		}
		const restored = await loadEvent(uow, id);
		await planReminder(uow, restored, now);
		uow.emit(eventChanged, { eventId: id });
		return toDetail(restored);
	},
});
