import { addVersion, compareThing, type DbExecutor, type Migrations, namesThing } from '@famos/sdk';
import {
	addDays,
	compareDates,
	dayBounds,
	epochOf,
	expandDates,
	expandTimed,
	fromRRule,
	type Recurrence,
	toRRule,
	zoned,
} from '@famos/time';
import { type Generated, type Selectable, sql } from 'kysely';
import type { EventDetail, EventInput, Occurrence } from '../contract/index.ts';
import {
	defaultReminder,
	EventInputSchema,
	endsNextDay,
	normalizeTags,
	SUBSCRIPTION_COLORS,
	tagKey,
} from '../contract/index.ts';

/** Storage for the calendar (tables prefixed `calendar_`). */
export type CalendarTables = {
	calendar_events: {
		id: string;
		title: string;
		notes: string | null;
		location: string | null;
		all_day: number;
		/** Timed events: instants. */
		starts_at: number | null;
		ends_at: number | null;
		/** All-day events: inclusive dates. */
		start_date: string | null;
		end_date: string | null;
		time_zone: string;
		rrule: string | null;
		/** JSON array: epoch ms (timed) or YYYY-MM-DD (all-day). */
		exdates: string | null;
		/** JSON array of member IDs; empty = whole family. */
		member_ids: string;
		/**
		 * Minutes before the start (all-day: before 09:00 local). Meaningful only when
		 * `reminder_set` is 1; null then means "no reminder".
		 */
		reminder_minutes: number | null;
		/** 0 = nobody chose: the default applies. */
		reminder_set: number;
		/** JSON array of tag names (at most 5); null = none. */
		tags: string | null;
		/**
		 * A date moved out of a repeating event with "Only this one": the series' id. Null for every
		 * other event, and for dates moved before the link existed.
		 */
		series_id: string | null;
		/** With `series_id`: the original occurrence key, the same value the series' `exdates` hold. */
		recurrence_key: string | null;
		created_by: string | null;
		source_kind: string | null;
		source_id: string | null;
		created_at: number;
		updated_at: number;
		deleted_at: number | null;
		/** Goes up by one on every write of the row (a trigger does it); what `ifMatch` compares. */
		version: Generated<number>;
	};
	/** The family's tags with their colours; `key` is the case-folded name. */
	calendar_tags: {
		key: string;
		name: string;
		/** `#rrggbb`. */
		color: string;
		created_at: number;
	};
	/** Secret ICS addresses out. Only the hash of the token is stored. */
	calendar_feeds: {
		id: string;
		token_hash: string;
		/** `family` or a member id. */
		scope: string;
		include_notes: number;
		label: string | null;
		created_by: string | null;
		created_at: number;
		last_used_at: number | null;
		revoked_at: number | null;
	};
	/** Read-only external calendars in. */
	calendar_subscriptions: {
		id: string;
		name: string;
		/** The address is a credential: sealed with FAMOS_SECRET, never returned. */
		sealed_url: string;
		/** Host name for display only. */
		url_host: string;
		/** `#rrggbb`. */
		color: string;
		/** JSON array of member IDs; empty = everyone. */
		member_ids: string;
		reminders: number;
		allow_local: number;
		etag: string | null;
		last_modified: string | null;
		last_fetched_at: number | null;
		/** A code only (`unreachable`, `http_404`, …), never a message or an address. */
		last_error: string | null;
		event_count: number;
		created_by: string | null;
		created_at: number;
		updated_at: number;
	};
	/**
	 * One VEVENT of a subscription: the series (`recurrence_key` '') or one override of it. Same
	 * time columns as family events. Replaced as a whole on every refresh.
	 */
	calendar_external_events: {
		subscription_id: string;
		uid: string;
		/** '' for the series; for an override the original start (epoch ms, or YYYY-MM-DD all-day). */
		recurrence_key: string;
		title: string;
		location: string | null;
		notes: string | null;
		all_day: number;
		starts_at: number | null;
		ends_at: number | null;
		start_date: string | null;
		end_date: string | null;
		time_zone: string;
		rrule: string | null;
		/** JSON array: epoch ms (timed) or YYYY-MM-DD (all-day); includes replaced and cancelled occurrences. */
		exdates: string | null;
		/** Hash of the content: reminders planned for an unchanged event stay valid across refreshes. */
		fingerprint: string;
		/** JSON array of the feed's CATEGORIES; null = none. */
		tags: string | null;
	};
};
export type EventRow = Selectable<CalendarTables['calendar_events']>;
export type FeedRow = CalendarTables['calendar_feeds'];
export type SubscriptionRow = CalendarTables['calendar_subscriptions'];
export type TagRow = CalendarTables['calendar_tags'];
export type ExternalEventRow = CalendarTables['calendar_external_events'];

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('calendar_events')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('title', 'text', (c) => c.notNull())
				.addColumn('notes', 'text')
				.addColumn('location', 'text')
				.addColumn('all_day', 'integer', (c) => c.notNull().check(sql`all_day in (0, 1)`))
				.addColumn('starts_at', 'integer')
				.addColumn('ends_at', 'integer')
				.addColumn('start_date', 'text')
				.addColumn('end_date', 'text')
				.addColumn('time_zone', 'text', (c) => c.notNull())
				.addColumn('rrule', 'text')
				.addColumn('exdates', 'text')
				.addColumn('member_ids', 'text', (c) => c.notNull())
				.addColumn('created_by', 'text')
				.addColumn('source_kind', 'text')
				.addColumn('source_id', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('deleted_at', 'integer')
				.addColumn('reminder_minutes', 'integer')
				// "Never chosen" (0) differs from "explicitly none".
				.addColumn('reminder_set', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('tags', 'text')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('calendar_events_start_idx')
				.on('calendar_events')
				.columns(['starts_at'])
				.execute();
			await db.schema
				.createIndex('calendar_events_date_idx')
				.on('calendar_events')
				.columns(['start_date'])
				.execute();

			await db.schema
				.createTable('calendar_feeds')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('token_hash', 'text', (c) => c.notNull().unique())
				.addColumn('scope', 'text', (c) => c.notNull())
				.addColumn('include_notes', 'integer', (c) =>
					c.notNull().check(sql`include_notes in (0, 1)`),
				)
				.addColumn('label', 'text')
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('last_used_at', 'integer')
				.addColumn('revoked_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();

			await db.schema
				.createTable('calendar_subscriptions')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('name', 'text', (c) => c.notNull())
				.addColumn('sealed_url', 'text', (c) => c.notNull())
				.addColumn('url_host', 'text', (c) => c.notNull())
				.addColumn('color', 'text', (c) => c.notNull())
				.addColumn('member_ids', 'text', (c) => c.notNull())
				.addColumn('reminders', 'integer', (c) => c.notNull().check(sql`reminders in (0, 1)`))
				.addColumn('allow_local', 'integer', (c) => c.notNull().check(sql`allow_local in (0, 1)`))
				.addColumn('etag', 'text')
				.addColumn('last_modified', 'text')
				.addColumn('last_fetched_at', 'integer')
				.addColumn('last_error', 'text')
				.addColumn('event_count', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createTable('calendar_external_events')
				.addColumn('subscription_id', 'text', (c) =>
					c.notNull().references('calendar_subscriptions.id').onDelete('cascade'),
				)
				.addColumn('uid', 'text', (c) => c.notNull())
				.addColumn('recurrence_key', 'text', (c) => c.notNull())
				.addColumn('title', 'text', (c) => c.notNull())
				.addColumn('location', 'text')
				.addColumn('notes', 'text')
				.addColumn('all_day', 'integer', (c) => c.notNull().check(sql`all_day in (0, 1)`))
				.addColumn('starts_at', 'integer')
				.addColumn('ends_at', 'integer')
				.addColumn('start_date', 'text')
				.addColumn('end_date', 'text')
				.addColumn('time_zone', 'text', (c) => c.notNull())
				.addColumn('rrule', 'text')
				.addColumn('exdates', 'text')
				.addColumn('fingerprint', 'text', (c) => c.notNull())
				.addColumn('tags', 'text')
				.addPrimaryKeyConstraint('calendar_external_events_pk', [
					'subscription_id',
					'uid',
					'recurrence_key',
				])
				.modifyEnd(sql`strict`)
				.execute();

			await db.schema
				.createTable('calendar_tags')
				.addColumn('key', 'text', (c) => c.primaryKey())
				.addColumn('name', 'text', (c) => c.notNull())
				.addColumn('color', 'text', (c) => c.notNull())
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
		},
	},
	// A date moved out of a series keeps the series' id and the occurrence it replaced. Dates
	// moved before this migration stay unlinked: nothing in a standalone row says which series it
	// came from (a title can be edited, a series can be split), so a guess could join the wrong ones.
	'0002_series_link': {
		async up(db) {
			await db.schema.alterTable('calendar_events').addColumn('series_id', 'text').execute();
			await db.schema.alterTable('calendar_events').addColumn('recurrence_key', 'text').execute();
			await db.schema
				.createIndex('calendar_events_series_idx')
				.on('calendar_events')
				.columns(['series_id'])
				.execute();
		},
	},
	'0003_version': {
		async up(db) {
			await addVersion(db, 'calendar_events');
		},
	},
};

export const events = (db: DbExecutor) => db.withTables<CalendarTables>();

/** Titles compared loosely: case (also I/ı/İ), accents and spacing do not matter. */
export const sameTitle = (a: string, b: string) => {
	const norm = (s: string) =>
		s
			.trim()
			.replace(/\s+/g, ' ')
			.toLowerCase()
			.replace(/ı/g, 'i')
			.normalize('NFKD')
			.replace(/\p{M}/gu, '');
	return norm(a) === norm(b);
};

/** How far from a new event's day an event with the same title still counts as the same one. */
export const SAME_EVENT_DAYS = 30;

/**
 * Whether the event seems to be on the calendar already, by the same title matching that finds a
 * moved event (`namesThing`, an `exact` or `strong` match: the words of one title are all words
 * of the other and no code or number differs, so "Parents' evening" is "Parents' evening at
 * school"), by the same code of letters and digits ("U13 fixture" and "U13 Eagles away game"),
 * or the same title written differently (case, accents). Any day within a month either
 * side counts: news that an event moved arrives with the new day, and the event is still the one
 * on the calendar, not a second one. Repeating events count by each of their dates.
 */
export async function eventExists(
	db: DbExecutor,
	input: { title: string; date: string },
	settings: { timeZone: string; locale: string },
): Promise<boolean> {
	const near = await occurrencesBetween(
		db,
		addDays(input.date, -SAME_EVENT_DAYS),
		addDays(input.date, SAME_EVENT_DAYS),
		settings.timeZone,
	);
	return near.some(
		(o) =>
			sameTitle(o.title, input.title) ||
			namesThing(input.title, o.title, { language: settings.locale }) ||
			compareThing(input.title, o.title, { language: settings.locale }).reason === 'code',
	);
}

const HOUR = 3_600_000;

/** Converts validated input to the stored representation, in the family time zone. */
export function toRow(input: EventInput, timeZone: string) {
	const v = EventInputSchema.parse(input);
	// Omitted = the default; null = none; a number = that preset.
	const reminder =
		v.reminder === undefined
			? { reminder_minutes: null, reminder_set: 0 }
			: { reminder_minutes: v.reminder, reminder_set: 1 };
	const tags = normalizeTags(v.tags);
	const rrule = v.recurrence ? toRRule(v.recurrence, v.allDay ? null : timeZone) : null;
	if (v.allDay) {
		return {
			title: v.title,
			notes: v.notes ?? null,
			location: v.location ?? null,
			all_day: 1,
			starts_at: null,
			ends_at: null,
			start_date: v.date,
			end_date: v.endDate ?? v.date,
			time_zone: timeZone,
			rrule,
			member_ids: JSON.stringify(v.memberIds),
			tags: tags.length ? JSON.stringify(tags) : null,
			...reminder,
		};
	}
	const startsAt = epochOf(v.date, v.startTime as string, timeZone);
	const endsAt = v.endTime
		? epochOf(
				endsNextDay(v.startTime, v.endTime) ? addDays(v.date, 1) : v.date,
				v.endTime,
				timeZone,
			)
		: startsAt + HOUR;
	return {
		title: v.title,
		notes: v.notes ?? null,
		location: v.location ?? null,
		all_day: 0,
		starts_at: startsAt,
		ends_at: endsAt,
		start_date: null,
		end_date: null,
		time_zone: timeZone,
		rrule,
		member_ids: JSON.stringify(v.memberIds),
		tags: tags.length ? JSON.stringify(tags) : null,
		...reminder,
	};
}

/**
 * The stored row for a whole replacement of a saved event. What the form does not carry stays:
 * the event's own time zone while its date and time are the same, and, when the form says it
 * left the repeat as it was (`keepRule`), a repeat rule outside the presets, which the form
 * cannot show and so sends no rule for. Without `keepRule` no rule means the event does not repeat.
 */
export function replacementRow(
	row: EventRow,
	input: EventInput,
	familyTimeZone: string,
	keepRule = false,
) {
	const own = toRow(input, row.time_zone);
	const sameWhen =
		own.all_day === row.all_day &&
		own.starts_at === row.starts_at &&
		own.ends_at === row.ends_at &&
		own.start_date === row.start_date &&
		own.end_date === row.end_date;
	const next = sameWhen ? own : toRow(input, familyTimeZone);
	if (keepRule && row.rrule && !input.recurrence && !fromRRule(row.rrule, row.time_zone))
		next.rrule = row.rrule;
	return next;
}

/**
 * The skipped dates of a series after it was replaced. They stay while its start, its time of
 * day, all-day and its rule are the same. Otherwise a skipped day stays skipped only if the new
 * rule still has a date on that day (moved to the new time); the others are dropped. Dates moved
 * out with "only this one" are events of their own and are not touched here.
 */
export function skippedAfter(row: EventRow, next: ReturnType<typeof toRow>): string | null {
	if (!row.exdates || !next.rrule) return null;
	const same =
		next.all_day === row.all_day &&
		next.starts_at === row.starts_at &&
		next.start_date === row.start_date &&
		sameRule(row, next.rrule);
	if (same) return row.exdates;
	const old: (string | number)[] = JSON.parse(row.exdates);
	const days = old
		.map((e) =>
			row.all_day ? String(e) : zoned(Number(e), row.time_zone).toPlainDate().toString(),
		)
		.sort();
	const from = days[0] as string;
	const to = days[days.length - 1] as string;
	const dayOf = (o: Expanded) =>
		o.allDay ? o.startDate : zoned(o.start, next.time_zone).toPlainDate().toString();
	const kept = expandRow({ ...row, ...next, exdates: null }, from, to, next.time_zone)
		.filter((o) => days.includes(dayOf(o)))
		.map((o) => (o.allDay ? o.key : Number(o.key)));
	return kept.length ? JSON.stringify(kept) : null;
}

/** Whether a stored rule and a new one say the same, whatever the order of their parts. */
function sameRule(row: EventRow, rrule: string): boolean {
	if (row.rrule === rrule) return true;
	const stored = fromRRule(row.rrule as string, row.time_zone);
	return stored !== null && toRRule(stored, row.all_day ? null : row.time_zone) === rrule;
}

/** The reminder in effect: the chosen one, or the default for rows nobody chose for. */
export function effectiveReminder(row: EventRow): number | null {
	return row.reminder_set === 1 ? row.reminder_minutes : defaultReminder(row.all_day === 1);
}

/** The tags stored in a JSON column. */
export const tagsOf = (json: string | null): string[] =>
	json ? (JSON.parse(json) as string[]) : [];

export function toDetail(row: EventRow): EventDetail {
	const recurrence: Recurrence | null = row.rrule ? fromRRule(row.rrule, row.time_zone) : null;
	const local = (ms: number | null) => (ms === null ? null : zoned(ms, row.time_zone));
	const start = local(row.starts_at);
	const end = local(row.ends_at);
	return {
		id: row.id,
		title: row.title,
		allDay: row.all_day === 1,
		date: row.all_day ? (row.start_date as string) : (start?.toPlainDate().toString() as string),
		endDate: row.all_day && row.end_date !== row.start_date ? row.end_date : null,
		startTime: start ? start.toPlainTime().toString().slice(0, 5) : null,
		endTime: end ? end.toPlainTime().toString().slice(0, 5) : null,
		memberIds: JSON.parse(row.member_ids) as string[],
		location: row.location,
		notes: row.notes,
		recurrence,
		reminder: effectiveReminder(row),
		rrule: row.rrule && !recurrence ? row.rrule : null,
		tags: tagsOf(row.tags),
		...link(row),
	};
}

/** `seriesId` and `recurrenceKey` of a date moved out of a series; nothing for any other event. */
export const link = (row: Pick<EventRow, 'series_id' | 'recurrence_key'>) =>
	row.series_id && row.recurrence_key !== null
		? { seriesId: row.series_id, recurrenceKey: row.recurrence_key }
		: {};

/** Where an occurrence of an event row starts and ends (one entry per occurrence in the range). */
export type Expanded =
	| { allDay: true; key: string; startDate: string; endDate: string }
	| { allDay: false; key: string; start: number; end: number };

/**
 * Occurrences of one event row overlapping the inclusive local date range. Family events and
 * subscription events share this: both are rows with the same time columns.
 */
export function expandRow(
	row: Pick<
		EventRow,
		| 'all_day'
		| 'start_date'
		| 'end_date'
		| 'starts_at'
		| 'ends_at'
		| 'time_zone'
		| 'rrule'
		| 'exdates'
	>,
	from: string,
	to: string,
	timeZone: string,
): Expanded[] {
	const out: Expanded[] = [];
	const exdates: (string | number)[] = row.exdates ? JSON.parse(row.exdates) : [];
	if (row.all_day) {
		const startDate = row.start_date as string;
		const endDate = row.end_date ?? startDate;
		const spanDays = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000);
		// Include series that started before `from` but still cover it.
		const starts = expandDates(
			{ date: startDate, rrule: row.rrule, exdates: exdates.map(String) },
			addDays(from, -spanDays),
			to,
		);
		for (const s of starts) {
			const e = addDays(s, spanDays);
			if (compareDates(e, from) < 0) continue;
			out.push({ allDay: true, key: s, startDate: s, endDate: e });
		}
		return out;
	}
	const rangeStart = dayBounds(from, timeZone).start;
	const rangeEnd = dayBounds(to, timeZone).end;
	const startsAt = row.starts_at as number;
	const duration = (row.ends_at as number) - startsAt;
	const starts = expandTimed(
		{ startsAt, timeZone: row.time_zone, rrule: row.rrule, exdates: exdates.map(Number) },
		rangeStart - duration,
		rangeEnd,
	);
	for (const s of starts) {
		// An event without length (external feeds allow it) still shows at its own instant.
		if (duration > 0 ? s + duration <= rangeStart : s < rangeStart) continue;
		out.push({ allDay: false, key: String(s), start: s, end: s + duration });
	}
	return out;
}

/** The order the agenda lists occurrences in: all-day first on their day, then by start. */
export const sortOccurrences = (list: Occurrence[], timeZone: string): Occurrence[] => {
	const sortKey = (o: Occurrence) =>
		o.allDay ? dayBounds(o.startDate as string, timeZone).start - 1 : (o.start as number);
	return list.sort((a, b) => sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));
};

/**
 * Occurrences of the family's own events overlapping the inclusive local date range. Their notes
 * come only with `withNotes`: a calendar page opens the event to read them, an answer about the
 * days needs them at once.
 */
export async function occurrencesBetween(
	db: DbExecutor,
	from: string,
	to: string,
	timeZone: string,
	options: { withNotes?: boolean } = {},
): Promise<Occurrence[]> {
	const rangeStart = dayBounds(from, timeZone).start;
	const rangeEnd = dayBounds(to, timeZone).end;
	const rows = await events(db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('deleted_at', 'is', null)
		.where((eb) =>
			eb.or([
				eb.and([
					eb('all_day', '=', 0),
					eb('starts_at', '<', rangeEnd),
					eb.or([eb('rrule', 'is not', null), eb('ends_at', '>', rangeStart)]),
				]),
				eb.and([
					eb('all_day', '=', 1),
					eb('start_date', '<=', to),
					eb.or([eb('rrule', 'is not', null), eb('end_date', '>=', from)]),
				]),
			]),
		)
		.execute();

	const out: Occurrence[] = [];
	for (const row of rows) {
		const base = {
			eventId: row.id,
			title: row.title,
			memberIds: JSON.parse(row.member_ids) as string[],
			location: row.location,
			recurring: row.rrule !== null,
			notes: options.withNotes === true ? row.notes : null,
			source: null,
			editable: true,
			tags: tagsOf(row.tags),
			...link(row),
		};
		for (const x of expandRow(row, from, to, timeZone)) {
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
	return sortOccurrences(out, timeZone);
}

/** A subscription event shaped like a family event, so expansion and reminders are shared. */
export function externalAsEvent(row: ExternalEventRow, sub: SubscriptionRow): EventRow {
	return {
		id: `${row.subscription_id}:${row.uid}:${row.recurrence_key}`,
		title: row.title,
		notes: row.notes,
		location: row.location,
		all_day: row.all_day,
		starts_at: row.starts_at,
		ends_at: row.ends_at,
		start_date: row.start_date,
		end_date: row.end_date,
		time_zone: row.time_zone,
		rrule: row.rrule,
		exdates: row.exdates,
		member_ids: sub.member_ids,
		tags: row.tags,
		series_id: null,
		recurrence_key: null,
		// Nobody chose: the default lead time applies.
		reminder_minutes: null,
		reminder_set: 0,
		created_by: null,
		source_kind: 'subscription',
		source_id: sub.id,
		created_at: 0,
		updated_at: 0,
		deleted_at: null,
		version: 0,
	};
}

/**
 * Makes sure every tag used on an event is in the family's list, with the next free colour of the
 * palette. Existing tags keep their colour and spelling.
 */
export async function ensureTags(db: DbExecutor, names: readonly string[], now: number) {
	if (names.length === 0) return;
	const t = events(db);
	const rows = await t.selectFrom('calendar_tags').select(['key', 'color']).execute();
	const known = new Set(rows.map((r) => r.key));
	const used = rows.map((r) => r.color);
	for (const name of names) {
		const key = tagKey(name);
		if (known.has(key)) continue;
		known.add(key);
		const color =
			SUBSCRIPTION_COLORS.find((c) => !used.includes(c)) ??
			(SUBSCRIPTION_COLORS[used.length % SUBSCRIPTION_COLORS.length] as string);
		used.push(color);
		await t.insertInto('calendar_tags').values({ key, name, color, created_at: now }).execute();
	}
}
