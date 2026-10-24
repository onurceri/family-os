import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type ExtensionPackage, type ExtensionState, forgetExtension } from '@famos/core';
import type { DatabaseHandle } from '@famos/db';
import { type DbExecutor, RESERVED_TABLE_PREFIXES, tablePrefixOf } from '@famos/sdk';
import { sql } from 'kysely';

/**
 * Removing an uninstalled extension's data for good (`famos extensions purge <id>`). Uninstalling
 * keeps the data, so installing again brings it back; purging is the step after that, taken on
 * the command line only. Everything the extension stored goes: its tables (found by the table
 * prefix recorded when it last ran, since its code may no longer be here), its migration records
 * (so a later install starts fresh), its files, and every row and setting the host keeps about it.
 * What the host keeps as history (the audit log, AI usage that counts towards the family's limits)
 * stays.
 */

/** What purging needs to know about the server: what is installed, what runs, what exists. */
export interface PurgeContext {
	state: ExtensionState | null;
	/** The ids the server loads at its next start (always installed ones included). */
	installed: readonly string[];
	/** The ids this process loaded. */
	loaded: readonly string[];
	/** Every package this server has, shipped or stored. */
	packages: readonly ExtensionPackage[];
}

export interface PurgeTarget {
	id: string;
	tablePrefix: string;
}

/** Names the host keeps besides the reserved prefixes: SQLite's own tables. */
const HOST_PREFIXES = [...RESERVED_TABLE_PREFIXES, 'sqlite_'];

const overlaps = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * The extension to purge and the prefix of its tables, or an error that says why it may not be
 * purged. Every check is about what the prefix could reach: a prefix that another extension's or
 * the host's tables could also start with would remove what is not this extension's.
 */
export function purgeTarget(id: string, context: PurgeContext): PurgeTarget {
	const pkg = context.packages.find((p) => p.id === id);
	if (pkg?.always) throw new Error(`${id} is always installed; its data cannot be removed`);
	if (context.installed.includes(id) || context.state?.installed.includes(id))
		throw new Error(`${id} is installed. Uninstall it first: famos extensions uninstall ${id}`);
	// What the last start loaded runs until the next one, in every process of that server (a
	// worker too), so only a start without it shows that nothing uses its tables any more.
	if (context.loaded.includes(id) || context.state?.loaded?.includes(id))
		throw new Error(`${id} is still running. Restart FamilyOS first so it stops using ${id}`);
	const known = context.state?.known[id];
	if (!known)
		throw new Error(`${id} never ran on this server, so there is no data of it to remove`);
	const prefix = known.tablePrefix;
	const host = HOST_PREFIXES.find((p) => overlaps(p, prefix));
	if (host) throw new Error(`${id}'s table prefix "${prefix}" overlaps the host's "${host}"`);
	const others = [
		...Object.entries(context.state?.known ?? {}).map(([other, entry]) => ({
			id: other,
			prefix: entry.tablePrefix,
		})),
		...context.packages.map((p) => ({ id: p.id, prefix: tablePrefixOf(p.manifest) })),
	];
	const clash = others.find((other) => other.id !== id && overlaps(other.prefix, prefix));
	if (clash)
		throw new Error(
			`${id}'s table prefix "${prefix}" overlaps ${clash.id}'s "${clash.prefix}"; remove its data by hand`,
		);
	return { id, tablePrefix: prefix };
}

interface SchemaObject {
	type: 'table' | 'index' | 'view' | 'trigger';
	name: string;
}

/** The tables, indexes, views and triggers whose names start with the prefix. */
async function objectsOf(db: DbExecutor, prefix: string): Promise<SchemaObject[]> {
	// `like` treats `_` as a wildcard, so the prefix is compared exactly.
	const { rows } = await sql<SchemaObject>`select type, name from sqlite_master
		where substr(name, 1, ${prefix.length}) = ${prefix}
			and type in ('table', 'index', 'view', 'trigger')
		order by name`.execute(db);
	return rows;
}

/** What a purge would remove from the database's schema and the files directory. */
export interface PurgePreview {
	tables: string[];
	files: number;
}

export async function previewPurge(
	db: DbExecutor,
	target: PurgeTarget,
	filesDir: string,
): Promise<PurgePreview> {
	const objects = await objectsOf(db, target.tablePrefix);
	return {
		tables: objects.filter((o) => o.type === 'table').map((o) => o.name),
		files: await countFiles(join(filesDir, target.id)),
	};
}

export interface PurgeSummary {
	tables: string[];
	views: string[];
	indexes: string[];
	triggers: string[];
	migrations: number;
	/** Rows removed from the host's tables, by what they were. */
	rows: Record<string, number>;
	/** The host's settings that named the extension and were cleaned. */
	settings: string[];
	files: number;
}

/**
 * Removes the extension's data. The database part is one transaction, so it all goes or none of
 * it does; the files go after it commits, since a file removed cannot be put back if the
 * transaction fails. Foreign keys are off while it runs: the extension's own tables may point at
 * each other, and are dropped in any order. They are checked before the commit.
 */
export async function purgeExtension(
	handle: Pick<DatabaseHandle, 'db' | 'sqlite'>,
	target: PurgeTarget,
	options: { filesDir: string; now: number },
): Promise<PurgeSummary> {
	const { id, tablePrefix } = target;
	const ns = `${id}.`;
	const summary: PurgeSummary = {
		tables: [],
		views: [],
		indexes: [],
		triggers: [],
		migrations: 0,
		rows: {},
		settings: [],
		files: 0,
	};
	handle.sqlite.pragma('foreign_keys = OFF');
	try {
		await handle.db.transaction().execute(async (trx) => {
			const objects = await objectsOf(trx, tablePrefix);
			// Views and triggers first: dropping a table a view reads leaves the view broken.
			for (const type of ['view', 'trigger', 'table', 'index'] as const) {
				for (const object of objects.filter((o) => o.type === type)) {
					const exists = await sql<{ n: number }>`select count(*) as n from sqlite_master
						where type = ${type} and name = ${object.name}`.execute(trx);
					// An index or trigger on one of its tables went with the table.
					if (!exists.rows[0]?.n) continue;
					const name = sql.id(object.name);
					if (type === 'view') await sql`drop view ${name}`.execute(trx);
					else if (type === 'trigger') await sql`drop trigger ${name}`.execute(trx);
					else if (type === 'table') await sql`drop table ${name}`.execute(trx);
					else await sql`drop index ${name}`.execute(trx);
				}
				const removed = objects.filter((o) => o.type === type).map((o) => o.name);
				if (type === 'view') summary.views = removed;
				else if (type === 'trigger') summary.triggers = removed;
				else if (type === 'table') summary.tables = removed;
				else summary.indexes = removed;
			}

			summary.migrations = await deleted(
				sql`delete from _migrations where scope = ${id}`.execute(trx),
			);
			const prefixed = (column: string, value: string) =>
				sql`substr(${sql.ref(column)}, 1, ${value.length}) = ${value}`;
			const count = async (label: string, query: Promise<{ numAffectedRows?: bigint }>) => {
				const n = await deleted(query);
				if (n > 0) summary.rows[label] = (summary.rows[label] ?? 0) + n;
			};
			// Its jobs, and notices waiting to be sent whose texts are its own.
			await count(
				'jobs',
				sql`delete from queue_jobs where ${prefixed('name', ns)}
					or (name = 'core.notify' and json_valid(payload)
						and substr(json_extract(payload, '$.kind'), 1, ${ns.length}) = ${ns})`.execute(trx),
			);
			// What the host's own tables and settings keep about it.
			const forgotten = await forgetExtension(trx, id, options.now);
			for (const [label, n] of Object.entries(forgotten.rows))
				summary.rows[label] = (summary.rows[label] ?? 0) + n;
			summary.settings.push(...forgotten.settings);

			const broken = await sql`pragma foreign_key_check`.execute(trx);
			if (broken.rows.length > 0)
				throw new Error('Removing it would leave rows pointing at nothing; nothing was removed');
		});
	} finally {
		handle.sqlite.pragma('foreign_keys = ON');
	}
	const dir = join(options.filesDir, id);
	summary.files = await countFiles(dir);
	await rm(dir, { recursive: true, force: true });
	return summary;
}

/** The lines that tell a person what was removed. */
export function describePurge(id: string, summary: PurgeSummary): string[] {
	const lines = [`Removed the data of ${id}:`];
	const list = (label: string, names: string[]) => {
		if (names.length > 0) lines.push(`  ${label} (${names.length}): ${names.join(', ')}`);
	};
	list('tables', summary.tables);
	list('views', summary.views);
	list('indexes', summary.indexes);
	list('triggers', summary.triggers);
	lines.push(`  migration records: ${summary.migrations}`);
	for (const [label, n] of Object.entries(summary.rows)) lines.push(`  ${label}: ${n}`);
	if (summary.settings.length > 0) lines.push(`  settings cleaned: ${summary.settings.join(', ')}`);
	lines.push(`  files: ${summary.files}`);
	return lines;
}

async function deleted(query: Promise<{ numAffectedRows?: bigint }>): Promise<number> {
	return Number((await query).numAffectedRows ?? 0n);
}

async function countFiles(dir: string): Promise<number> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	return entries.filter((entry) => entry.isFile()).length;
}
