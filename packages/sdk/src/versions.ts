import { sql } from 'kysely';
import type { DbExecutor } from './ports.ts';

/**
 * Gives a table a `version`: an integer that starts at 0 and goes up by one on every write of
 * the row, whatever column the write touches. A trigger does it, so no code path (an action, a
 * job, a bulk update, raw SQL) can forget, and `updated_at` keeps meaning only what it meant
 * before. Callers that want to change a row only if it is still as they read it name the version
 * (`ActionTarget.versionColumn`). For a migration: it adds a column and a trigger.
 */
export async function addVersion(db: DbExecutor, table: string): Promise<void> {
	await sql`alter table ${sql.id(table)} add column version integer not null default 0`.execute(db);
	await sql`create trigger ${sql.id(`${table}_version`)} after update on ${sql.id(table)}
		when new.version is old.version
		begin
			update ${sql.id(table)} set version = version + 1 where rowid = new.rowid;
		end`.execute(db);
}

/**
 * Raises the version of a parent row whenever a row of a child table that belongs to it is
 * added, changed or removed: for a parent whose shape shows what the child holds. `parentKey` is
 * the parent's id column, `childKey` the child column that points at it.
 */
export async function bumpParentVersion(
	db: DbExecutor,
	options: { parent: string; child: string; childKey: string; parentKey?: string },
): Promise<void> {
	const { parent, child, childKey, parentKey = 'id' } = options;
	const name = (event: string) => sql.id(`${child}_${event}_bump_${parent}`);
	const key = sql.id(parentKey);
	const old = sql.raw(`old.${childKey}`);
	const added = sql.raw(`new.${childKey}`);
	await sql`create trigger ${name('insert')} after insert on ${sql.id(child)} begin
		update ${sql.id(parent)} set version = version + 1 where ${key} = ${added};
	end`.execute(db);
	// One statement for both ends, so a row that stays with its parent counts once.
	await sql`create trigger ${name('update')} after update on ${sql.id(child)} begin
		update ${sql.id(parent)} set version = version + 1 where ${key} = ${added} or ${key} = ${old};
	end`.execute(db);
	await sql`create trigger ${name('delete')} after delete on ${sql.id(child)} begin
		update ${sql.id(parent)} set version = version + 1 where ${key} = ${old};
	end`.execute(db);
}
