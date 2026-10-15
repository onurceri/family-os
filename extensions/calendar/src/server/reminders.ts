import { defineJob, defineNotificationKind, type NotifyRequest } from '@famos/sdk';
import { addDays, dayBounds, expandDates, expandTimed, Temporal, todayIn } from '@famos/time';
import { z } from 'zod';
import { type EventRow, effectiveReminder, events, externalAsEvent } from './store.ts';

/**
 * Event reminders. Only the next reminder of an event is scheduled (`calendar.remind` with
 * `runAt`); when it runs, it tells the people and schedules the one after it. Every change to an
 * event schedules afresh in the same transaction, and a job carries the event's `updated_at`, the
 * occurrence and the instant it was planned for, so a job that no longer matches does nothing.
 */
export const reminderKind = defineNotificationKind({
	id: 'calendar.reminder',
	label: 'calendar:notify_kind_reminder',
	audience: 'calendar.view',
});

/** A reminder may be this late at scheduling time (clock drift) and still go out. */
const LATE_MS = 5 * 60_000;
/** How far ahead to look for the next occurrence of a series (covers yearly events). */
const LOOKAHEAD_DAYS = 400;
const DAY_MS = 86_400_000;
/** All-day reminders count back from this local time on the day. */
const ALL_DAY_ANCHOR = '09:00';

const exdatesOf = (row: EventRow): (string | number)[] =>
	row.exdates ? JSON.parse(row.exdates) : [];

/** The instant a reminder for an occurrence is due. */
export function reminderInstant(row: EventRow, key: string, lead: number): number {
	if (!row.all_day) return Number(key) - lead * 60_000;
	return Temporal.PlainDateTime.from(`${key}T${ALL_DAY_ANCHOR}`)
		.subtract({ minutes: lead })
		.toZonedDateTime(row.time_zone, { disambiguation: 'compatible' })
		.toInstant().epochMilliseconds;
}

/** Whether the occurrence still exists (the series was not changed, the date not skipped). */
function occurrenceExists(row: EventRow, key: string): boolean {
	const exdates = exdatesOf(row);
	if (row.all_day) {
		return (
			expandDates(
				{ date: row.start_date as string, rrule: row.rrule, exdates: exdates.map(String) },
				key,
				key,
			).length === 1
		);
	}
	const start = Number(key);
	return (
		expandTimed(
			{
				startsAt: row.starts_at as number,
				timeZone: row.time_zone,
				rrule: row.rrule,
				exdates: exdates.map(Number),
			},
			start,
			start + 1,
		).length === 1
	);
}

/** The first occurrence (after `afterKey`) whose reminder is still worth sending at `now`. */
export function nextReminder(
	row: EventRow,
	now: number,
	afterKey?: string,
): { key: string; at: number } | null {
	const lead = effectiveReminder(row);
	if (lead === null) return null;
	const exdates = exdatesOf(row);
	if (row.all_day) {
		const today = todayIn(row.time_zone, now);
		const keys = expandDates(
			{ date: row.start_date as string, rrule: row.rrule, exdates: exdates.map(String) },
			addDays(today, -1),
			addDays(today, LOOKAHEAD_DAYS),
		);
		for (const key of keys) {
			if (afterKey !== undefined && key <= afterKey) continue;
			const at = reminderInstant(row, key, lead);
			if (at >= now - LATE_MS) return { key, at };
		}
		return null;
	}
	let from = now - LATE_MS + lead * 60_000;
	if (afterKey !== undefined) from = Math.max(from, Number(afterKey) + 1);
	const [first] = expandTimed(
		{
			startsAt: row.starts_at as number,
			timeZone: row.time_zone,
			rrule: row.rrule,
			exdates: exdates.map(Number),
		},
		from,
		from + LOOKAHEAD_DAYS * DAY_MS,
	);
	return first === undefined
		? null
		: { key: String(first), at: reminderInstant(row, String(first), lead) };
}

const RemindPayload = z.object({
	eventId: z.string(),
	/** The occurrence: epoch ms of the start (timed) or YYYY-MM-DD (all-day). */
	key: z.string(),
	/** The instant this reminder was planned for. */
	at: z.number(),
	/** The event's `updated_at` (or, for a subscription event, its fingerprint) when it was planned. */
	version: z.union([z.number(), z.string()]),
	/** Set for an event of a subscription; then `eventId` is only a label. */
	external: z
		.object({ subscriptionId: z.string(), uid: z.string(), recurrenceKey: z.string() })
		.optional(),
});
type RemindPayload = z.infer<typeof RemindPayload>;

type Enqueue = (
	job: string,
	payload: unknown,
	options?: { runAt?: number; dedupeKey?: string },
) => Promise<unknown>;

/** Plans the next reminder of an event (nothing if it has none, or none is left). */
export async function scheduleReminder(
	enqueue: Enqueue,
	row: EventRow,
	now: number,
	afterKey?: string,
	external?: { subscriptionId: string; uid: string; recurrenceKey: string; version: string },
): Promise<void> {
	const next = nextReminder(row, now, afterKey);
	if (!next) return;
	const version = external?.version ?? row.updated_at;
	const payload: RemindPayload = {
		eventId: row.id,
		key: next.key,
		at: next.at,
		version,
		...(external && {
			external: {
				subscriptionId: external.subscriptionId,
				uid: external.uid,
				recurrenceKey: external.recurrenceKey,
			},
		}),
	};
	await enqueue('calendar.remind', payload, {
		runAt: next.at,
		dedupeKey: `calendar.remind:${row.id}:${next.key}:${version}:${next.at}`,
	});
}

function message(
	row: EventRow,
	key: string,
	timeZone: string,
	source: { kind: string; id: string },
): NotifyRequest {
	const members = JSON.parse(row.member_ids) as string[];
	const where = row.location ? { location: row.location } : null;
	const time = row.all_day ? null : { at: Number(key), timeZone };
	const body = time
		? {
				key: where ? 'calendar:reminder_timed_where' : 'calendar:reminder_timed',
				params: { time, ...where },
			}
		: {
				key: where ? 'calendar:reminder_all_day_where' : 'calendar:reminder_all_day',
				...(where && { params: where }),
			};
	return {
		kind: reminderKind.id,
		to: members.length > 0 ? { members } : { capability: 'calendar.view' },
		title: { key: 'calendar:reminder_title', params: { title: row.title } },
		body,
		url: '/calendar',
		source,
		dedupeKey: `reminder:${row.id}:${key}`,
	};
}

export const remindJob = defineJob({
	name: 'calendar.remind',
	payload: RemindPayload,
	async handle(ctx, { eventId, key, at, version, external }) {
		let row: EventRow | undefined;
		let source = { kind: 'calendar.event', id: eventId };
		if (external) {
			const ext = await events(ctx.db)
				.selectFrom('calendar_external_events')
				.selectAll()
				.where('subscription_id', '=', external.subscriptionId)
				.where('uid', '=', external.uid)
				.where('recurrence_key', '=', external.recurrenceKey)
				.executeTakeFirst();
			const sub = await events(ctx.db)
				.selectFrom('calendar_subscriptions')
				.selectAll()
				.where('id', '=', external.subscriptionId)
				.executeTakeFirst();
			// Replaced by a refresh, removed, or reminders turned off since: nothing to say.
			if (!ext || !sub || sub.reminders !== 1 || ext.fingerprint !== version) return;
			row = externalAsEvent(ext, sub);
			source = { kind: 'calendar.subscription', id: sub.id };
		} else {
			row = await events(ctx.db)
				.selectFrom('calendar_events')
				.selectAll()
				.where('id', '=', eventId)
				.where('deleted_at', 'is', null)
				.executeTakeFirst();
			// Changed, deleted or skipped since: the change planned its own reminder.
			if (!row || row.updated_at !== version) return;
		}
		if (!row) return;
		const lead = effectiveReminder(row);
		if (lead === null || !occurrenceExists(row, key) || reminderInstant(row, key, lead) !== at)
			return;

		const now = ctx.clock.now();
		// The job may have waited a long time (server down): do not remind about the past.
		const over = row.all_day ? dayBounds(key, row.time_zone).end : Number(key) + LATE_MS;
		if (now <= over) await ctx.notify(message(row, key, row.time_zone, source));
		if (row.rrule) {
			await scheduleReminder(
				(job, payload, options) => ctx.enqueue(job, payload, options),
				row,
				now,
				key,
				external && { ...external, version: String(version) },
			);
		}
	},
});
