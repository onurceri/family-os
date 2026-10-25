import { openDatabase, runMigrations } from '@famos/testing';
import { epochOf } from '@famos/time';
import { type Kysely, type KyselyPlugin, sql } from 'kysely';
import { expect, it } from 'vitest';
import { migrations, occurrencesBetween, seriesEndOf } from '../src/server/store.ts';
import { externalOccurrencesBetween } from '../src/server/subscriptions.ts';

const TZ = 'Europe/Istanbul';

/** Remembers the ids of the event rows each query returned. */
const spy = () => {
	const returned: string[] = [];
	const columns = new Set<string>();
	const plugin: KyselyPlugin = {
		transformQuery: ({ node }) => node,
		transformResult: async ({ result }) => {
			for (const r of result.rows as { id?: string; uid?: string }[]) {
				for (const c of Object.keys(r)) columns.add(c);
				const id = r.id ?? r.uid;
				if (id) returned.push(id);
			}
			return result;
		},
	};
	return { plugin, returned, columns };
};

const seed = async (db: Kysely<object>) => {
	const at = epochOf('2026-01-05', '09:00', TZ);
	const timed = (id: string, rrule: string) => {
		const end = seriesEndOf({
			all_day: 0,
			starts_at: at,
			ends_at: at + 3_600_000,
			start_date: null,
			end_date: null,
			time_zone: TZ,
			rrule,
		});
		return sql`insert into calendar_events (id, title, all_day, starts_at, ends_at, time_zone, rrule, series_end, member_ids, created_at, updated_at)
			values (${id}, ${id}, 0, ${at}, ${at + 3_600_000}, ${TZ}, ${rrule}, ${end}, '[]', 1, 1)`.execute(
			db,
		);
	};
	const allDay = (id: string, rrule: string) => {
		const end = seriesEndOf({
			all_day: 1,
			starts_at: null,
			ends_at: null,
			start_date: '2026-01-05',
			end_date: '2026-01-05',
			time_zone: TZ,
			rrule,
		});
		return sql`insert into calendar_events (id, title, all_day, start_date, end_date, time_zone, rrule, series_end, member_ids, created_at, updated_at)
			values (${id}, ${id}, 1, '2026-01-05', '2026-01-05', ${TZ}, ${rrule}, ${end}, '[]', 1, 1)`.execute(
			db,
		);
	};
	await timed('timed_open', 'FREQ=WEEKLY;BYDAY=MO');
	await timed('timed_ended', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260301T205959Z');
	await timed('timed_reaches', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101T205959Z');
	await timed('timed_count', 'FREQ=WEEKLY;BYDAY=MO;COUNT=3');
	await allDay('day_ended', 'FREQ=DAILY;UNTIL=20260301');
	await allDay('day_last', 'FREQ=DAILY;UNTIL=20261012');
};

const fresh = async () => {
	const handle = openDatabase({ path: ':memory:' });
	await runMigrations(handle.db, [{ scope: 'calendar', migrations }]);
	return handle;
};

it('finds when a repeat rule ends: the real last occurrence for a count, the limit for UNTIL', () => {
	const at = epochOf('2026-01-05', '09:00', TZ);
	const timed = (rrule: string | null) =>
		seriesEndOf({
			all_day: 0,
			starts_at: at,
			ends_at: at + 3_600_000,
			start_date: null,
			end_date: null,
			time_zone: TZ,
			rrule,
		});
	// Mondays 5, 12 and 19 January: the third one ends an hour after 09:00.
	expect(timed('FREQ=WEEKLY;BYDAY=MO;COUNT=3')).toBe(epochOf('2026-01-19', '10:00', TZ));
	expect(timed('FREQ=WEEKLY;UNTIL=20260301T205959Z')).toBe(
		Date.UTC(2026, 2, 1, 20, 59, 59) + 3_600_000,
	);
	expect(timed('FREQ=WEEKLY')).toBeNull();
	expect(timed(null)).toBeNull();
	expect(timed('FREQ=SECONDLY;COUNT=999999')).toBeNull();
	const day = (rrule: string) =>
		seriesEndOf({
			all_day: 1,
			starts_at: null,
			ends_at: null,
			start_date: '2026-01-05',
			end_date: '2026-01-06',
			time_zone: TZ,
			rrule,
		});
	expect(day('FREQ=DAILY;COUNT=3')).toBe(Date.UTC(2026, 0, 8));
	expect(day('FREQ=DAILY;UNTIL=20260301')).toBe(Date.UTC(2026, 2, 2));
});

it('leaves repeating events that ended before the range out of the read', async () => {
	const handle = await fresh();
	await seed(handle.db);
	const { plugin, returned } = spy();
	const found = await occurrencesBetween(
		handle.db.withPlugin(plugin),
		'2026-10-12',
		'2026-10-18',
		TZ,
	);

	expect(returned.sort()).toEqual(['day_last', 'timed_open', 'timed_reaches']);
	// The last day of a series counts: the Monday it ends on is still listed.
	expect(found.filter((o) => o.title === 'day_last').map((o) => o.key)).toEqual(['2026-10-12']);
	expect(found.filter((o) => o.title === 'timed_reaches')).toHaveLength(1);
	expect(found.filter((o) => o.title === 'timed_ended')).toEqual([]);
	await handle.close();
});

it('keeps a series that ends the day before the range only if an occurrence still runs into it', async () => {
	const handle = await fresh();
	const { db } = handle;
	// 23:00 to 02:00 next day, ending with the Sunday 11 October occurrence.
	const at = epochOf('2026-10-04', '23:00', TZ);
	const rrule = 'FREQ=WEEKLY;UNTIL=20261011T205959Z';
	const end = seriesEndOf({
		all_day: 0,
		starts_at: at,
		ends_at: at + 3 * 3_600_000,
		start_date: null,
		end_date: null,
		time_zone: TZ,
		rrule,
	});
	await sql`insert into calendar_events (id, title, all_day, starts_at, ends_at, time_zone, rrule, series_end, member_ids, created_at, updated_at)
		values ('late', 'late', 0, ${at}, ${at + 3 * 3_600_000}, ${TZ}, ${rrule}, ${end}, '[]', 1, 1)`.execute(
		db,
	);
	const found = await occurrencesBetween(db, '2026-10-12', '2026-10-12', TZ);
	expect(found.map((o) => o.title)).toEqual(['late']);
	expect(await occurrencesBetween(db, '2026-10-13', '2026-10-13', TZ)).toEqual([]);
	await handle.close();
});

it('reads subscriptions without their address and skips ended feed series', async () => {
	const handle = await fresh();
	const { db } = handle;
	await sql`insert into calendar_subscriptions
		(id, name, sealed_url, url_host, color, member_ids, reminders, allow_local, created_at, updated_at)
		values ('s1', 'Club', 'SEALED', 'club.example', '#3f7fb5', '[]', 0, 0, 1, 1)`.execute(db);
	const at = epochOf('2026-01-05', '09:00', TZ);
	for (const [uid, rrule] of [
		['ended', 'FREQ=WEEKLY;UNTIL=20260301T000000Z'],
		['open', 'FREQ=WEEKLY'],
	] as const) {
		const end = seriesEndOf({
			all_day: 0,
			starts_at: at,
			ends_at: at + 3_600_000,
			start_date: null,
			end_date: null,
			time_zone: TZ,
			rrule,
		});
		await sql`insert into calendar_external_events
			(subscription_id, uid, recurrence_key, title, all_day, starts_at, ends_at, time_zone, rrule, series_end, fingerprint)
			values ('s1', ${uid}, '', ${uid}, 0, ${at}, ${at + 3_600_000}, ${TZ}, ${rrule}, ${end}, 'f')`.execute(
			db,
		);
	}

	const { plugin, returned, columns } = spy();
	const spied = handle.db.withPlugin(plugin);
	const found = await externalOccurrencesBetween(spied, '2026-10-12', '2026-10-18', TZ);

	expect(found.map((o) => o.title)).toEqual(['open']);
	expect(returned).toContain('s1');
	expect(returned).not.toContain('ended');
	expect(columns.has('sealed_url')).toBe(false);
	expect(JSON.stringify(found)).not.toContain('SEALED');
	await handle.close();
});
