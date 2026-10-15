import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionPackage, ExtensionState } from '@famos/core';
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
	/** The ids running now: in this process, and in a server that answers on this machine. */
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
	if (context.loaded.includes(id))
		throw new Error(`${id} is still running. Restart FamilyOS after uninstalling it, then purge`);
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

/** True for an id the extension owns: itself, or anything in its namespace (`pets.view`). */
const ownedBy = (id: string) => (name: string) => name === id || name.startsWith(`${id}.`);

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
	const owned = ownedBy(id);
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
			await count(
				'drafts',
				sql`delete from core_drafts where ${prefixed('action_id', ns)}`.execute(trx),
			);
			await count(
				'notifications',
				sql`delete from core_notifications where ${prefixed('kind', ns)}`.execute(trx),
			);
			await count(
				'answers kept for retried requests',
				sql`delete from core_idempotency where ${prefixed('action_id', ns)}`.execute(trx),
			);
			await count(
				'search index entries',
				sql`delete from core_embeddings where extension_id = ${id}`.execute(trx),
			);
			await count(
				'file grants',
				sql`delete from core_file_grants where grantee = ${id}
					or ${prefixed('key', `${id}/`)}`.execute(trx),
			);

			const cleaned = (label: string, changed: boolean) => {
				if (changed && !summary.settings.includes(label)) summary.settings.push(label);
			};
			cleaned(
				'role permissions',
				await editColumn(trx, 'core_roles', 'id', 'overrides', (value) =>
					withoutKeys(value, owned),
				),
			);
			cleaned(
				'notification preferences',
				await editColumn(trx, 'core_notification_prefs', 'member_id', 'prefs', (value) => {
					if (!isRecord(value) || !isRecord(value.kinds)) return value;
					return { ...value, kinds: withoutKeys(value.kinds, owned) };
				}),
			);
			cleaned(
				'what displays may show',
				await editColumn(trx, 'core_devices', 'id', 'display_capabilities', (value) =>
					withoutItems(value, owned),
				),
			);
			cleaned(
				'what displays may show',
				await editColumn(trx, 'core_display_pairings', 'id', 'capabilities', (value) =>
					withoutItems(value, owned),
				),
			);
			const setting = (key: string, edit: (value: unknown) => unknown) =>
				editSetting(trx, 'core_settings', key, edit, options.now);
			cleaned(
				'features',
				await setting('features', (value) =>
					isRecord(value) ? { ...value, disabled: withoutItems(value.disabled, owned) } : value,
				),
			);
			cleaned('AI areas', await setting('ai_areas', (value) => withoutKeys(value, owned)));
			cleaned(
				'AI switches',
				await editSetting(
					trx,
					'ai_settings',
					'switches',
					(value) => (isRecord(value) ? { ...value, off: withoutItems(value.off, owned) } : value),
					options.now,
				),
			);
			cleaned(
				'automatic approvals',
				await setting('core.autoApproval', (value) => {
					if (!isRecord(value)) return value;
					return Object.fromEntries(
						Object.entries(value).filter(
							([action, entry]) =>
								!owned(action) &&
								!(isRecord(entry) && typeof entry.proposerCapability === 'string'
									? owned(entry.proposerCapability)
									: false),
						),
					);
				}),
			);
			cleaned(
				'search index',
				await setting('search_index', (value) =>
					isRecord(value) ? { ...value, built: withoutKeys(value.built, (k) => k === id) } : value,
				),
			);
			cleaned(
				'what Today hides',
				await setting('today.hidden', (value) => {
					if (!isRecord(value)) return value;
					const each = (choices: unknown) =>
						isRecord(choices)
							? Object.fromEntries(
									Object.entries(choices).map(([who, hidden]) => [
										who,
										withoutItems(hidden, owned),
									]),
								)
							: choices;
					return {
						...value,
						family: withoutItems(value.family, owned),
						members: each(value.members),
						displays: each(value.displays),
					};
				}),
			);
			cleaned(
				'installed extensions',
				await setting('extensions', (value) => {
					if (!isRecord(value)) return value;
					return {
						...value,
						installed: withoutItems(value.installed, (x) => x === id),
						known: withoutKeys(value.known, (k) => k === id),
						failed: Array.isArray(value.failed)
							? value.failed.filter((f) => !(isRecord(f) && f.id === id))
							: value.failed,
					};
				}),
			);

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function withoutKeys(value: unknown, drop: (key: string) => boolean): unknown {
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => !drop(key)));
}

function withoutItems(value: unknown, drop: (item: string) => boolean): unknown {
	if (!Array.isArray(value)) return value;
	return value.filter((item) => !(typeof item === 'string' && drop(item)));
}

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/** Rewrites a JSON column in every row where the edit changes it; true when one changed. */
async function editColumn(
	db: DbExecutor,
	table: string,
	key: string,
	column: string,
	edit: (value: unknown) => unknown,
): Promise<boolean> {
	const { rows } = await sql<{ k: string; v: string | null }>`select ${sql.ref(key)} as k,
		${sql.ref(column)} as v from ${sql.table(table)}`.execute(db);
	let changed = false;
	for (const row of rows) {
		if (row.v === null) continue;
		const parsed = parse(row.v);
		if (!parsed.ok) continue;
		const next = JSON.stringify(edit(parsed.value));
		if (next === JSON.stringify(parsed.value)) continue;
		await sql`update ${sql.table(table)} set ${sql.ref(column)} = ${next}
			where ${sql.ref(key)} = ${row.k}`.execute(db);
		changed = true;
	}
	return changed;
}

/** Rewrites one JSON value of a settings table (`key`, `value`, `updated_at`) when it changes. */
async function editSetting(
	db: DbExecutor,
	table: string,
	key: string,
	edit: (value: unknown) => unknown,
	now: number,
): Promise<boolean> {
	const { rows } = await sql<{ value: string }>`select value from ${sql.table(table)}
		where key = ${key}`.execute(db);
	const row = rows[0];
	if (!row) return false;
	const parsed = parse(row.value);
	if (!parsed.ok) return false;
	const next = JSON.stringify(edit(parsed.value));
	if (next === JSON.stringify(parsed.value)) return false;
	await sql`update ${sql.table(table)} set value = ${next}, updated_at = ${now}
		where key = ${key}`.execute(db);
	return true;
}

async function countFiles(dir: string): Promise<number> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	return entries.filter((entry) => entry.isFile()).length;
}
