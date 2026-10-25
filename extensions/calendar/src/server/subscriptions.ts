import {
	assertActiveMembers,
	defineAction,
	defineJob,
	defineRoute,
	type EnqueueJob,
	ExternalHttpError,
	FamosError,
	isExternalHttpError,
	type JobContext,
	selfOf,
	type UnitOfWork,
} from '@famos/sdk';
import { dayBounds, HOUR_MS } from '@famos/time';
import { z } from 'zod';
import {
	AddSubscriptionInputSchema,
	type Occurrence,
	SUBSCRIPTION_COLORS,
	SubscriptionIdSchema,
	SubscriptionSchema,
	UpdateSubscriptionInputSchema,
} from '../contract/index.ts';
import { calendarManage, subscriptionChanged } from './capabilities.ts';
import { NotCalendarError, parseCalendar, TooManyEventsError } from './ical-import.ts';
import { scheduleReminder } from './reminders.ts';
import {
	type ExternalEventRow,
	events,
	expandRow,
	externalAsEvent,
	type SubscriptionRow,
	seriesEndOf,
	seriesReaches,
	tagsOf,
} from './store.ts';

/**
 * Read-only subscriptions to external calendars. The address is a credential: it is
 * sealed, shown only as its host, and never logged. A refresh job fetches it (conditionally),
 * parses it and replaces the subscription's events in one transaction; a failed refresh keeps
 * what was there and records an error code.
 */

/** Every subscription is refreshed this often. */
const REFRESH_EVERY_MS = 6 * HOUR_MS;

/** The host of a feed address, or null when it is not an acceptable shape. */
export function feedHost(raw: string): string | null {
	try {
		const url = new URL(raw.trim().replace(/^webcals?:/i, 'https:'));
		if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
		return url.hostname.toLowerCase();
	} catch {
		return null;
	}
}

const RefreshPayload = z.object({ subscriptionId: z.string() });

/** Asks for a refresh now (once, however often it is asked). */
const refreshNow = (enqueue: EnqueueJob, subscriptionId: string) =>
	enqueue(
		'calendar.refreshSubscription',
		{ subscriptionId },
		{
			dedupeKey: `calendar.refreshNow:${subscriptionId}`,
		},
	);

/**
 * Plans the next scheduled refresh. Slots are fixed six-hour windows, so however many refreshes
 * happen in one window, only one follow-up exists; a small per-subscription offset spreads them.
 */
async function scheduleNext(enqueue: EnqueueJob, subscriptionId: string, now: number) {
	const slot = Math.floor(now / REFRESH_EVERY_MS) + 1;
	let spread = 0;
	for (const char of subscriptionId) spread = (spread * 31 + char.charCodeAt(0)) % (30 * 60_000);
	await enqueue(
		'calendar.refreshSubscription',
		{ subscriptionId },
		{
			runAt: slot * REFRESH_EVERY_MS + spread,
			dedupeKey: `calendar.refresh:${subscriptionId}:${slot}`,
		},
	);
}

export function toSubscription(row: SubscriptionRow) {
	return {
		id: row.id,
		name: row.name,
		host: row.url_host,
		color: row.color,
		memberIds: JSON.parse(row.member_ids) as string[],
		reminders: row.reminders === 1,
		allowLocal: row.allow_local === 1,
		lastFetchedAt: row.last_fetched_at,
		lastError: row.last_error,
		eventCount: row.event_count,
	};
}

async function loadSubscription(db: UnitOfWork['db'], id: string) {
	const row = await events(db)
		.selectFrom('calendar_subscriptions')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Subscription not found');
	return row;
}

export const addSubscription = defineAction({
	id: 'calendar.addSubscription',
	title: 'Subscribe to an external calendar (read-only)',
	input: AddSubscriptionInputSchema,
	output: SubscriptionSchema,
	requires: calendarManage.id,
	approval: 'never',
	async run(uow, input) {
		const host = feedHost(input.url);
		if (!host) throw new FamosError('bad_request', 'The address must be https: or webcal:');
		await assertActiveMembers(uow, input.memberIds, 'memberIds');
		const db = events(uow.db);
		const used = await db.selectFrom('calendar_subscriptions').select('color').execute();
		const color =
			input.color ??
			SUBSCRIPTION_COLORS.find((c) => !used.some((u) => u.color === c)) ??
			(SUBSCRIPTION_COLORS[used.length % SUBSCRIPTION_COLORS.length] as string);
		const now = uow.clock.now();
		const row: SubscriptionRow = {
			id: uow.ids.next('cal_sub'),
			name: input.name,
			sealed_url: uow.secrets.seal(input.url.trim()),
			url_host: host,
			color,
			member_ids: JSON.stringify(input.memberIds),
			reminders: input.reminders ? 1 : 0,
			allow_local: input.allowLocal ? 1 : 0,
			etag: null,
			last_modified: null,
			last_fetched_at: null,
			last_error: null,
			event_count: 0,
			created_by: selfOf(uow.actor),
			created_at: now,
			updated_at: now,
		};
		await db.insertInto('calendar_subscriptions').values(row).execute();
		await refreshNow((job, payload, o) => uow.enqueue(job, payload, o), row.id);
		uow.emit(subscriptionChanged, { subscriptionId: row.id });
		return toSubscription(row);
	},
});

export const updateSubscription = defineAction({
	id: 'calendar.updateSubscription',
	title: 'Change an external calendar subscription',
	input: UpdateSubscriptionInputSchema,
	output: SubscriptionSchema,
	requires: calendarManage.id,
	approval: 'never',
	async run(uow, input) {
		const current = await loadSubscription(uow.db, input.id);
		await assertActiveMembers(uow, input.memberIds ?? [], 'memberIds');
		const set: Partial<SubscriptionRow> = { updated_at: uow.clock.now() };
		if (input.name !== undefined) set.name = input.name;
		if (input.color !== undefined) set.color = input.color;
		if (input.memberIds !== undefined) set.member_ids = JSON.stringify(input.memberIds);
		if (input.reminders !== undefined) set.reminders = input.reminders ? 1 : 0;
		if (input.allowLocal !== undefined) set.allow_local = input.allowLocal ? 1 : 0;
		let refresh = input.reminders !== undefined || input.memberIds !== undefined;
		if (input.url !== undefined) {
			const host = feedHost(input.url);
			if (!host) throw new FamosError('bad_request', 'The address must be https: or webcal:');
			set.sealed_url = uow.secrets.seal(input.url.trim());
			set.url_host = host;
			// What was cached belongs to the old address.
			set.etag = null;
			set.last_modified = null;
			refresh = true;
		}
		if (input.allowLocal !== undefined && (input.allowLocal ? 1 : 0) !== current.allow_local)
			refresh = true;
		await events(uow.db)
			.updateTable('calendar_subscriptions')
			.set(set)
			.where('id', '=', input.id)
			.execute();
		if (refresh) await refreshNow((job, payload, o) => uow.enqueue(job, payload, o), input.id);
		uow.emit(subscriptionChanged, { subscriptionId: input.id });
		return toSubscription(await loadSubscription(uow.db, input.id));
	},
});

export const removeSubscription = defineAction({
	id: 'calendar.removeSubscription',
	title: 'Remove an external calendar subscription and its events',
	input: z.object({ id: SubscriptionIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	requires: calendarManage.id,
	approval: 'never',
	async run(uow, { id }) {
		await loadSubscription(uow.db, id);
		const db = events(uow.db);
		await db.deleteFrom('calendar_external_events').where('subscription_id', '=', id).execute();
		await db.deleteFrom('calendar_subscriptions').where('id', '=', id).execute();
		uow.emit(subscriptionChanged, { subscriptionId: id, op: 'delete' });
		return { ok: true as const };
	},
});

export const refreshSubscription = defineAction({
	id: 'calendar.refreshSubscription',
	title: 'Fetch an external calendar again now',
	input: z.object({ id: SubscriptionIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	requires: calendarManage.id,
	approval: 'never',
	async run(uow, { id }) {
		await loadSubscription(uow.db, id);
		await refreshNow((job, payload, o) => uow.enqueue(job, payload, o), id);
		return { ok: true as const };
	},
});

export const listSubscriptions = defineRoute({
	method: 'get',
	path: '/subscriptions',
	operationId: 'calendar.listSubscriptions',
	summary: 'External calendar subscriptions (host only, never the address)',
	requires: calendarManage.id,
	response: z.array(SubscriptionSchema),
	async handle(ctx) {
		const rows = await events(ctx.db)
			.selectFrom('calendar_subscriptions')
			.selectAll()
			.orderBy('created_at')
			.execute();
		return rows.map(toSubscription);
	},
});

/** The error code a failed fetch is recorded as. */
function errorCode(error: unknown): string {
	if (isExternalHttpError(error)) {
		if (error.code === 'blocked_address' || error.code === 'too_large' || error.code === 'bad_url')
			return error.code;
		if (error.code.startsWith('http_')) return error.code;
		return 'unreachable';
	}
	if (error instanceof NotCalendarError) return 'not_calendar';
	if (error instanceof TooManyEventsError) return 'too_large';
	return 'unreachable';
}

const INSERT_BATCH = 100;

/** Plans the next reminder of every event of a subscription that wants them. */
async function scheduleReminders(ctx: JobContext, sub: SubscriptionRow, now: number) {
	if (sub.reminders !== 1) return;
	const { reminderTime } = await ctx.family.settings();
	const rows = await events(ctx.db)
		.selectFrom('calendar_external_events')
		.selectAll()
		.where('subscription_id', '=', sub.id)
		.execute();
	for (const row of rows) {
		await scheduleReminder(
			(job, payload, options) => ctx.enqueue(job, payload, options),
			externalAsEvent(row, sub),
			now,
			reminderTime,
			undefined,
			{
				subscriptionId: sub.id,
				uid: row.uid,
				recurrenceKey: row.recurrence_key,
				version: row.fingerprint,
			},
		);
	}
}

export const refreshJob = defineJob({
	name: 'calendar.refreshSubscription',
	payload: RefreshPayload,
	timeoutMs: 60_000,
	maxAttempts: 3,
	async handle(ctx, { subscriptionId }) {
		const sub = await events(ctx.db)
			.selectFrom('calendar_subscriptions')
			.selectAll()
			.where('id', '=', subscriptionId)
			.executeTakeFirst();
		// Removed since: the chain of refreshes ends here.
		if (!sub) return;
		const now = ctx.clock.now();
		const log = ctx.logger.child({ subscription: sub.id, host: sub.url_host });
		// The write and its entry in the change log are one transaction, as for an action.
		const record = (set: Partial<SubscriptionRow>) =>
			ctx.unit(async (uow) => {
				await events(uow.db)
					.updateTable('calendar_subscriptions')
					.set(set)
					.where('id', '=', sub.id)
					.execute();
				uow.emit(subscriptionChanged, { subscriptionId: sub.id });
			});

		try {
			const url = ctx.secrets.open(sub.sealed_url);
			if (url === null) throw new ExternalHttpError('bad_url', 'The address cannot be opened');
			const response = await ctx.http.get({
				url,
				allowLocal: sub.allow_local === 1,
				conditional: { etag: sub.etag, lastModified: sub.last_modified },
			});
			if (response.status === 304) {
				await record({ last_fetched_at: now, last_error: null });
			} else {
				const { timeZone } = await ctx.family.settings();
				let skipped = 0;
				const parsed = parseCalendar(response.text, timeZone, now, () => skipped++);
				if (skipped > 0) {
					log.warn({ reason: 'rule_too_dense', series: skipped }, 'calendar feed series skipped');
				}
				const rows: ExternalEventRow[] = parsed.map((e) => ({
					subscription_id: sub.id,
					uid: e.uid,
					recurrence_key: e.recurrenceKey,
					title: e.title,
					location: e.location,
					notes: e.notes,
					all_day: e.allDay ? 1 : 0,
					starts_at: e.startsAt,
					ends_at: e.endsAt,
					start_date: e.startDate,
					end_date: e.endDate,
					time_zone: e.timeZone,
					rrule: e.rrule,
					series_end: seriesEndOf({
						all_day: e.allDay ? 1 : 0,
						starts_at: e.startsAt,
						ends_at: e.endsAt,
						start_date: e.startDate,
						end_date: e.endDate,
						time_zone: e.timeZone,
						rrule: e.rrule,
					}),
					exdates: e.exdates.length ? JSON.stringify(e.exdates) : null,
					fingerprint: e.fingerprint,
					tags: e.tags.length ? JSON.stringify(e.tags) : null,
				}));
				// Replaced as a whole: readers see the old events or the new ones, never a mix.
				await ctx.unit(async (uow) => {
					const t = events(uow.db);
					await t
						.deleteFrom('calendar_external_events')
						.where('subscription_id', '=', sub.id)
						.execute();
					for (let i = 0; i < rows.length; i += INSERT_BATCH) {
						await t
							.insertInto('calendar_external_events')
							.values(rows.slice(i, i + INSERT_BATCH))
							.execute();
					}
					await t
						.updateTable('calendar_subscriptions')
						.set({
							etag: response.etag,
							last_modified: response.lastModified,
							last_fetched_at: now,
							last_error: null,
							event_count: rows.length,
						})
						.where('id', '=', sub.id)
						.execute();
					uow.emit(subscriptionChanged, { subscriptionId: sub.id });
				});
			}
			await scheduleReminders(ctx, sub, now);
		} catch (error) {
			const code = errorCode(error);
			// Only the code and the host: the address and the feed's content stay out of logs.
			log.warn({ code }, 'calendar subscription refresh failed');
			await record({ last_error: code });
		}
		await scheduleNext((job, payload, o) => ctx.enqueue(job, payload, o), sub.id, now);
	},
});

/** Occurrences of all subscriptions overlapping the inclusive local date range. */
export async function externalOccurrencesBetween(
	db: UnitOfWork['db'],
	from: string,
	to: string,
	timeZone: string,
): Promise<Occurrence[]> {
	// Never the address (`sealed_url`): a read for the agenda needs only who it belongs to and how it looks.
	const subs = await events(db)
		.selectFrom('calendar_subscriptions')
		.select(['id', 'name', 'color', 'member_ids'])
		.execute();
	if (subs.length === 0) return [];
	const rangeStart = dayBounds(from, timeZone).start;
	const rangeEnd = dayBounds(to, timeZone).end;
	const rows = await events(db)
		.selectFrom('calendar_external_events')
		.selectAll()
		.where((eb) =>
			eb.or([
				eb.and([
					eb('all_day', '=', 0),
					eb('starts_at', '<', rangeEnd),
					eb.or([
						eb.and([eb('rrule', 'is not', null), seriesReaches(from, rangeStart)]),
						eb('ends_at', '>=', rangeStart),
					]),
				]),
				eb.and([
					eb('all_day', '=', 1),
					eb('start_date', '<=', to),
					eb.or([
						eb.and([eb('rrule', 'is not', null), seriesReaches(from, rangeStart)]),
						eb('end_date', '>=', from),
					]),
				]),
			]),
		)
		.execute();
	const byId = new Map(subs.map((s) => [s.id, s]));
	const out: Occurrence[] = [];
	for (const row of rows) {
		const sub = byId.get(row.subscription_id);
		if (!sub) continue;
		const event = externalAsEvent(row, sub);
		const base = {
			eventId: event.id,
			title: row.title,
			memberIds: JSON.parse(sub.member_ids) as string[],
			location: row.location,
			recurring: row.rrule !== null,
			notes: row.notes,
			source: { kind: 'subscription' as const, id: sub.id, name: sub.name, color: sub.color },
			editable: false,
			tags: tagsOf(row.tags),
		};
		for (const x of expandRow(event, from, to, timeZone)) {
			out.push(
				x.allDay
					? {
							...base,
							key: x.key,
							allDay: true,
							start: null,
							end: null,
							startDate: x.startDate,
							endDate: x.endDate,
						}
					: {
							...base,
							key: x.key,
							allDay: false,
							start: x.start,
							end: x.end,
							startDate: null,
							endDate: null,
						},
			);
		}
	}
	return out;
}
