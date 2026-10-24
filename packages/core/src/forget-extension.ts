import type { DbExecutor } from '@famos/sdk';
import { sql } from 'kysely';

/** What removing an extension's trace from the host's own tables and settings changed. */
export interface ForgottenExtension {
	/** Rows removed from the host's tables, by what they were. */
	rows: Record<string, number>;
	/** The host's settings that named the extension and were cleaned. */
	settings: string[];
}

/** True for an id the extension owns: itself, or anything in its namespace (`pets.view`). */
const ownedBy = (id: string) => (name: string) => name === id || name.startsWith(`${id}.`);

/**
 * Removes what the host keeps about an extension: its drafts, notifications, answers kept for
 * retried requests, search entries and file grants, and its ids in role overrides, notification
 * preferences, display capabilities, features, AI areas and switches, automatic approvals, the
 * search index state, Today's hidden blocks and the installed extensions' record. Runs in the
 * caller's transaction. History (the audit log, AI usage) stays. The extension's own tables, its
 * jobs, its migration records and its files are not the host's data and are removed by the caller.
 */
export async function forgetExtension(
	db: DbExecutor,
	id: string,
	now: number,
): Promise<ForgottenExtension> {
	const owned = ownedBy(id);
	const ns = `${id}.`;
	const summary: ForgottenExtension = { rows: {}, settings: [] };
	const prefixed = (column: string, value: string) =>
		sql`substr(${sql.ref(column)}, 1, ${value.length}) = ${value}`;
	const count = async (label: string, query: Promise<{ numAffectedRows?: bigint }>) => {
		const n = Number((await query).numAffectedRows ?? 0n);
		if (n > 0) summary.rows[label] = (summary.rows[label] ?? 0) + n;
	};
	await count(
		'drafts',
		sql`delete from core_drafts where ${prefixed('action_id', ns)}`.execute(db),
	);
	await count(
		'notifications',
		sql`delete from core_notifications where ${prefixed('kind', ns)}`.execute(db),
	);
	await count(
		'answers kept for retried requests',
		sql`delete from core_idempotency where ${prefixed('action_id', ns)}`.execute(db),
	);
	await count(
		'search index entries',
		sql`delete from core_embeddings where extension_id = ${id}`.execute(db),
	);
	await count(
		'file grants',
		sql`delete from core_file_grants where grantee = ${id}
			or ${prefixed('key', `${id}/`)}`.execute(db),
	);

	const cleaned = (label: string, changed: boolean) => {
		if (changed && !summary.settings.includes(label)) summary.settings.push(label);
	};
	cleaned(
		'role permissions',
		await editColumn(db, 'core_roles', 'id', 'overrides', (value) => withoutKeys(value, owned)),
	);
	cleaned(
		'notification preferences',
		await editColumn(db, 'core_notification_prefs', 'member_id', 'prefs', (value) => {
			if (!isRecord(value) || !isRecord(value.kinds)) return value;
			return { ...value, kinds: withoutKeys(value.kinds, owned) };
		}),
	);
	cleaned(
		'what displays may show',
		await editColumn(db, 'core_devices', 'id', 'display_capabilities', (value) =>
			withoutItems(value, owned),
		),
	);
	cleaned(
		'what displays may show',
		await editColumn(db, 'core_display_pairings', 'id', 'capabilities', (value) =>
			withoutItems(value, owned),
		),
	);
	const setting = (key: string, edit: (value: unknown) => unknown) =>
		editSetting(db, 'core_settings', key, edit, now);
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
			db,
			'ai_settings',
			'switches',
			(value) => (isRecord(value) ? { ...value, off: withoutItems(value.off, owned) } : value),
			now,
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
							Object.entries(choices).map(([who, hidden]) => [who, withoutItems(hidden, owned)]),
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

	return summary;
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
