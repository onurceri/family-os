import { openDatabase, runMigrations } from '@famos/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { migrations } from '../src/server/store.ts';

const open = async () => {
	const { db } = openDatabase({ path: ':memory:' });
	await runMigrations(db, [{ scope: 'chores', migrations }]);
	await sql`pragma foreign_keys = on`.execute(db);
	return db;
};

it('creates STRICT chores tables from empty', async () => {
	const db = await open();
	const list = await sql<{ name: string; strict: number }>`pragma table_list`.execute(db);
	const found = list.rows.filter((t) => t.name.startsWith('chores_'));
	expect(found.map((t) => t.name).sort()).toEqual([
		'chores_assignees',
		'chores_chores',
		'chores_completions',
		'chores_settings',
	]);
	expect(found.every((t) => t.strict === 1)).toBe(true);
});

it('keeps one live completion per chore and due date', async () => {
	const db = await open();
	const chore = (id: string, rotation = 'fixed') =>
		sql`insert into chores_chores (id, title, start_date, next_due, rotation, created_at, updated_at)
			values (${id}, 'Dishes', '2026-10-06', '2026-10-06', ${rotation}, 1, 1)`.execute(db);
	await chore('c1');
	await expect(chore('c3', 'random')).rejects.toThrow(); // unknown rotation

	const done = (id: string, undoneAt: number | null) =>
		sql`insert into chores_completions (id, chore_id, member_id, due_date, done_at, undone_at)
			values (${id}, 'c1', 'm1', '2026-10-06', 1, ${undoneAt})`.execute(db);
	await done('d1', null);
	await expect(done('d2', null)).rejects.toThrow(); // already done that day
	await done('d3', 5); // an undone one leaves room

	await sql`delete from chores_chores where id = 'c1'`.execute(db);
	const left = await sql<{ n: number }>`select count(*) as n from chores_completions`.execute(db);
	expect(left.rows[0]?.n).toBe(0); // completions go with their chore
});

it('upgrades a 0.14 database: chores stay as they were and the evening count keeps its default', async () => {
	const { db } = openDatabase({ path: ':memory:' });
	const released = Object.fromEntries(
		Object.entries(migrations).filter(([name]) => name !== '0003_settings'),
	);
	await runMigrations(db, [{ scope: 'chores', migrations: released }]);
	await sql`insert into chores_chores (id, title, start_date, next_due, created_at, updated_at)
		values ('c1', 'Dishes', '2026-10-06', '2026-10-06', 1, 1)`.execute(db);

	await runMigrations(db, [{ scope: 'chores', migrations }]);

	const chores = await sql`select id, title, next_due from chores_chores`.execute(db);
	expect(chores.rows).toEqual([{ id: 'c1', title: 'Dishes', next_due: '2026-10-06' }]);
	const settings = await sql`select * from chores_settings`.execute(db);
	expect(settings.rows).toEqual([]); // no row: the default time applies
	const list = await sql<{ name: string; strict: number }>`pragma table_list`.execute(db);
	expect(list.rows.find((t) => t.name === 'chores_settings')?.strict).toBe(1);
});
