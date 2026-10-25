import { openDatabase, runMigrations } from '@famos/testing';
import { epochOf } from '@famos/time';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { nextReminder } from '../src/server/reminders.ts';
import { type EventRow, migrations, toDetail } from '../src/server/store.ts';

const fresh = async () => {
	const handle = openDatabase({ path: ':memory:' });
	await runMigrations(handle.db, [{ scope: 'calendar', migrations }]);
	await sql`pragma foreign_keys = on`.execute(handle.db);
	return handle;
};

it('an event saved without a reminder choice gets the default', async () => {
	const handle = await fresh();
	const { db } = handle;
	const TZ = 'Europe/Istanbul';
	const start = epochOf('2026-10-20', '14:00', TZ);
	await sql`insert into calendar_events
		(id, title, all_day, starts_at, ends_at, time_zone, member_ids, created_at, updated_at)
		values ('cal_event_t', 'Timed', 0, ${start}, ${start + 3_600_000}, ${TZ}, '[]', 5, 5)`.execute(
		db,
	);
	await sql`insert into calendar_events
		(id, title, all_day, start_date, end_date, time_zone, member_ids, created_at, updated_at)
		values ('cal_event_d', 'All day', 1, '2026-10-21', '2026-10-21', ${TZ}, '[]', 5, 5)`.execute(
		db,
	);

	const rows = (await sql<EventRow>`select * from calendar_events order by id`.execute(db)).rows;
	const [allDay, timed] = rows as [EventRow, EventRow];
	expect(timed).toMatchObject({ reminder_set: 0, reminder_minutes: null, tags: null });
	expect(allDay).toMatchObject({ reminder_set: 0, reminder_minutes: null, tags: null });

	// 30 minutes before a timed event, 09:00 on the day for an all-day one.
	expect(toDetail(timed).reminder).toBe(30);
	expect(toDetail(allDay).reminder).toBe(0);
	const now = epochOf('2026-10-19', '10:00', TZ);
	expect(nextReminder(timed, now, '09:00')).toEqual({
		key: String(start),
		at: start - 30 * 60_000,
	});
	expect(nextReminder(allDay, now, '09:00')).toEqual({
		key: '2026-10-21',
		at: epochOf('2026-10-21', '09:00', TZ),
	});
	await handle.close();
});

it('subscription events are keyed by UID and recurrence and go with their subscription', async () => {
	const handle = await fresh();
	const { db } = handle;
	await sql`insert into calendar_subscriptions
		(id, name, sealed_url, url_host, color, member_ids, reminders, allow_local, created_at, updated_at)
		values ('cal_sub_a', 'School', 'v1.x', 'school.example', '#3f7fb5', '[]', 0, 0, 1, 1)`.execute(
		db,
	);
	await sql`insert into calendar_external_events
		(subscription_id, uid, recurrence_key, title, all_day, start_date, end_date, time_zone, fingerprint)
		values ('cal_sub_a', 'u1', '', 'Holiday', 1, '2026-10-29', '2026-10-29', 'Europe/Istanbul', 'f')`.execute(
		db,
	);
	await expect(
		sql`insert into calendar_external_events
			(subscription_id, uid, recurrence_key, title, all_day, time_zone, fingerprint)
			values ('cal_sub_a', 'u1', '', 'Again', 1, 'UTC', 'f')`.execute(db),
	).rejects.toThrow();
	await sql`delete from calendar_subscriptions where id = 'cal_sub_a'`.execute(db);
	expect((await sql`select * from calendar_external_events`.execute(db)).rows).toHaveLength(0);

	// A tag is identified by its folded name.
	await sql`insert into calendar_tags (key, name, color, created_at) values ('okul', 'Okul', '#3f7fb5', 1)`.execute(
		db,
	);
	await expect(
		sql`insert into calendar_tags (key, name, color, created_at) values ('okul', 'OKUL', '#c38f22', 2)`.execute(
			db,
		),
	).rejects.toThrow();
	await handle.close();
});

it('upgrades a 0.2.1 database: events stay as they were and gain empty link columns', async () => {
	const handle = openDatabase({ path: ':memory:' });
	const { db } = handle;
	// The schema 0.2.1 shipped: only the first migration.
	const released = Object.fromEntries(
		Object.entries(migrations).filter(([n]) => n === '0001_init'),
	);
	expect(Object.keys(released)).toEqual(['0001_init']);
	await runMigrations(db, [{ scope: 'calendar', migrations: released }]);
	const TZ = 'Europe/Istanbul';
	const start = epochOf('2026-10-20', '19:00', TZ);
	await sql`insert into calendar_events
		(id, title, all_day, starts_at, ends_at, time_zone, rrule, exdates, member_ids, created_at, updated_at)
		values ('cal_event_series', 'Bins', 0, ${start}, ${start + 1_800_000}, ${TZ}, 'FREQ=WEEKLY', ${`[${start}]`}, '[]', 5, 5)`.execute(
		db,
	);
	await sql`insert into calendar_events
		(id, title, all_day, starts_at, ends_at, time_zone, member_ids, created_at, updated_at)
		values ('cal_event_moved', 'Bins', 0, ${start + 86_400_000}, ${start + 88_200_000}, ${TZ}, '[]', 6, 6)`.execute(
		db,
	);

	await runMigrations(db, [{ scope: 'calendar', migrations }]);

	const rows = (await sql<EventRow>`select * from calendar_events order by id`.execute(db)).rows;
	expect(rows.map((r) => r.id)).toEqual(['cal_event_moved', 'cal_event_series']);
	// A date moved before the link existed cannot be tied to its series safely: it stays unlinked.
	for (const row of rows) expect(row).toMatchObject({ series_id: null, recurrence_key: null });
	expect(rows[1]?.exdates).toBe(`[${start}]`);
	expect(toDetail(rows[0] as EventRow)).not.toHaveProperty('seriesId');
	// Running the migrations again changes nothing.
	await runMigrations(db, [{ scope: 'calendar', migrations }]);
	await handle.close();
});

it('upgrades a 0.7.0 database: repeating events gain their end without being rewritten', async () => {
	const handle = openDatabase({ path: ':memory:' });
	const { db } = handle;
	const released = Object.fromEntries(
		Object.entries(migrations).filter(([n]) => n !== '0004_series_end'),
	);
	await runMigrations(db, [{ scope: 'calendar', migrations: released }]);
	const TZ = 'Europe/Istanbul';
	const start = epochOf('2026-10-20', '19:00', TZ);
	const timed = (id: string, rrule: string | null) =>
		sql`insert into calendar_events
			(id, title, all_day, starts_at, ends_at, time_zone, rrule, member_ids, created_at, updated_at)
			values (${id}, 'Bins', 0, ${start}, ${start + 1_800_000}, ${TZ}, ${rrule}, '[]', 5, 5)`.execute(
			db,
		);
	await timed('cal_event_until', 'FREQ=WEEKLY;UNTIL=20261231T205959Z');
	await timed('cal_event_count', 'FREQ=WEEKLY;COUNT=3');
	await timed('cal_event_open', 'FREQ=WEEKLY');
	await timed('cal_event_once', null);
	await sql`insert into calendar_subscriptions
		(id, name, sealed_url, url_host, color, member_ids, reminders, allow_local, created_at, updated_at)
		values ('cal_sub_a', 'School', 'v1.x', 'school.example', '#3f7fb5', '[]', 0, 0, 1, 1)`.execute(
		db,
	);
	await sql`insert into calendar_external_events
		(subscription_id, uid, recurrence_key, title, all_day, start_date, end_date, time_zone, rrule, fingerprint)
		values ('cal_sub_a', 'u1', '', 'Club', 1, '2026-10-20', '2026-10-20', ${TZ}, 'FREQ=DAILY;COUNT=2', 'f')`.execute(
		db,
	);
	const before = (
		await sql<{ version: number }>`select version from calendar_events order by id`.execute(db)
	).rows;

	await runMigrations(db, [{ scope: 'calendar', migrations }]);

	const { rows } = await sql<{ id: string; series_end: number | null; version: number }>`
		select id, series_end, version from calendar_events order by id`.execute(db);
	expect(rows.map((r) => [r.id, r.series_end])).toEqual([
		['cal_event_count', epochOf('2026-11-03', '19:30', TZ)],
		['cal_event_once', null],
		['cal_event_open', null],
		['cal_event_until', Date.UTC(2026, 11, 31, 20, 59, 59) + 1_800_000],
	]);
	expect(rows.map((r) => r.version)).toEqual(before.map((r) => r.version));
	const external = await sql<{
		series_end: number;
	}>`select series_end from calendar_external_events`.execute(db);
	expect(external.rows).toEqual([{ series_end: Date.UTC(2026, 9, 21) }]);
	await handle.close();
});
