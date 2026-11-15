import { openDatabase, runMigrations } from '@famos/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { migrations } from '../src/server/store.ts';

/** What the release before who-is-home had. */
const {
	'0007_switch_level': _level,
	'0006_notify': _notify,
	'0003_people': _people,
	'0004_control': _control,
	'0005_switches': _switches,
	...before
} = migrations;

it('adds the people to a home connected before, keeping what it shows', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'homeassistant', migrations: before }]);
	await sql`insert into homeassistant_connection (id, base_url, sealed_token, status, created_at, updated_at)
		values ('home', 'http://192.168.1.20:8123', 'sealed', 'ok', 1, 1)`.execute(db);
	await sql`insert into homeassistant_items (id, entity_id, label, position, created_at, updated_at)
		values ('ha_item_1', 'sensor.outside', 'Outside', 0, 1, 1)`.execute(db);

	await runMigrations(db, [{ scope: 'homeassistant', migrations }]);

	const items = await sql<{ label: string }>`select label from homeassistant_items`.execute(db);
	expect(items.rows).toEqual([{ label: 'Outside' }]);
	const list = await sql<{ name: string; strict: number }>`pragma table_list`.execute(db);
	expect(list.rows.find((t) => t.name === 'homeassistant_people')?.strict).toBe(1);

	// A new link shows nothing and nothing on displays until the person chooses.
	await sql`insert into homeassistant_people (member_id, person_entity, created_at, updated_at)
		values ('member_1', 'person.alex', 1, 1)`.execute(db);
	const people = await sql<{ level: string; on_displays: number }>`
		select level, on_displays from homeassistant_people`.execute(db);
	expect(people.rows).toEqual([{ level: 'none', on_displays: 0 }]);
	// A person is one member's at most.
	await expect(
		sql`insert into homeassistant_people (member_id, person_entity, created_at, updated_at)
			values ('member_2', 'person.alex', 1, 1)`.execute(db),
	).rejects.toThrow();
});

it('keeps what a home showed before switching existed, switchable by nobody and asking first', async () => {
	const {
		'0007_switch_level': _level,
		'0006_notify': _notify,
		'0004_control': _control,
		'0005_switches': _switches,
		...previous
	} = migrations;
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'homeassistant', migrations: previous }]);
	await sql`insert into homeassistant_items (id, entity_id, label, position, created_at, updated_at)
		values ('ha_item_1', 'lock.front_door', 'Front door', 0, 1, 1)`.execute(db);

	await runMigrations(db, [{ scope: 'homeassistant', migrations }]);

	const items = await sql<{ label: string; control: number; confirm: number }>`
		select label, control, confirm from homeassistant_items`.execute(db);
	expect(items.rows).toEqual([{ label: 'Front door', control: 0, confirm: 1 }]);
});

it('adds a phone for texts to the links of 0.2.0, with nothing chosen and nothing tried', async () => {
	const { '0007_switch_level': _level, '0006_notify': _notify, ...v020 } = migrations;
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'homeassistant', migrations: v020 }]);
	await sql`insert into homeassistant_people (member_id, person_entity, level, on_displays, created_at, updated_at)
		values ('member_1', 'person.alex', 'home', 1, 1, 1)`.execute(db);

	await runMigrations(db, [{ scope: 'homeassistant', migrations }]);

	const rows = await sql<{
		level: string;
		on_displays: number;
		notify_service: string | null;
		notify_status: string | null;
	}>`select level, on_displays, notify_service, notify_status from homeassistant_people`.execute(
		db,
	);
	expect(rows.rows).toEqual([
		{ level: 'home', on_displays: 1, notify_service: null, notify_status: null },
	]);
});

it('adds a fan speed to the switch history of 0.3.0, empty for the switches already made', async () => {
	const { '0007_switch_level': _level, ...v030 } = migrations;
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'homeassistant', migrations: v030 }]);
	await sql`insert into homeassistant_switches (id, item_id, entity_id, label, operation, member_id, ok, at)
		values ('job_1', 'ha_item_1', 'light.kitchen', 'Kitchen', 'turn_on', 'member_1', 1, 5)`.execute(
		db,
	);

	await runMigrations(db, [{ scope: 'homeassistant', migrations }]);

	await sql`insert into homeassistant_switches (id, item_id, entity_id, label, operation, level, ok, at)
		values ('job_2', 'ha_item_2', 'fan.winix', 'Air', 'set_percentage', 2, 1, 6)`.execute(db);
	const rows = await sql<{ id: string; operation: string; level: number | null }>`
		select id, operation, level from homeassistant_switches order by at`.execute(db);
	expect(rows.rows).toEqual([
		{ id: 'job_1', operation: 'turn_on', level: null },
		{ id: 'job_2', operation: 'set_percentage', level: 2 },
	]);
});
