import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';

/** A named set of migrations: `core`, an adapter, or an extension id. */
export interface MigrationScope {
	scope: string;
	migrations: Migrations;
}

export interface MigrationPlan {
	pending: { scope: string; name: string }[];
	/**
	 * Scopes the database has but this code does not: an extension that is no longer installed
	 * (removed, or turned into an optional pack). Its tables and data stay untouched; the server
	 * says so and starts.
	 */
	orphaned: { scope: string; names: string[] }[];
}

export class SchemaNewerThanCodeError extends Error {
	readonly scope: string;
	readonly unknown: string[];

	constructor(scope: string, unknown: string[]) {
		super(
			`Database has migrations unknown to this version of FamilyOS (${scope}: ${unknown.join(', ')}). ` +
				'It was created by a newer release. Install that release or restore an older backup.',
		);
		this.name = 'SchemaNewerThanCodeError';
		this.scope = scope;
		this.unknown = unknown;
	}
}

export class OutOfOrderMigrationError extends Error {
	readonly scope: string;
	readonly migration: string;
	readonly last: string;

	constructor(scope: string, migration: string, last: string) {
		super(
			`Migration ${scope}/${migration} sorts before already applied ${scope}/${last}. Rename it to run after.`,
		);
		this.name = 'OutOfOrderMigrationError';
		this.scope = scope;
		this.migration = migration;
		this.last = last;
	}
}

const TABLE = '_migrations';

type MigrationsTable = { _migrations: { scope: string; name: string; applied_at: number } };

/** A migration that threw: its own transaction was rolled back, earlier ones stay applied. */
export class MigrationFailedError extends Error {
	readonly scope: string;
	readonly migration: string;

	constructor(scope: string, migration: string, cause: unknown) {
		super(
			`Migration ${scope}/${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = 'MigrationFailedError';
		this.scope = scope;
		this.migration = migration;
	}
}

async function ensureTable(db: DbExecutor): Promise<void> {
	await db.schema
		.createTable(TABLE)
		.ifNotExists()
		.addColumn('scope', 'text', (c) => c.notNull())
		.addColumn('name', 'text', (c) => c.notNull())
		.addColumn('applied_at', 'integer', (c) => c.notNull())
		.addPrimaryKeyConstraint('_migrations_pk', ['scope', 'name'])
		.modifyEnd(sql`strict`)
		.execute();
}

async function applied(db: DbExecutor): Promise<Map<string, string[]>> {
	const rows = await db
		.withTables<MigrationsTable>()
		.selectFrom(TABLE)
		.select(['scope', 'name'])
		.orderBy('scope')
		.orderBy('name')
		.execute();
	const byScope = new Map<string, string[]>();
	for (const row of rows) byScope.set(row.scope, [...(byScope.get(row.scope) ?? []), row.name]);
	return byScope;
}

/**
 * Computes which migrations would run, enforcing forward-only migrations:
 * - a scope this code knows must not contain migrations it does not know (newer DB → refuse),
 * - new migrations must sort after the last applied one in their scope (no reordering).
 * A whole scope the code does not know is an extension that is not installed: it is reported in
 * `orphaned` and left alone, so removing an extension never stops the server.
 */
export async function planMigrations(
	db: DbExecutor,
	scopes: readonly MigrationScope[],
): Promise<MigrationPlan> {
	await ensureTable(db);
	const done = await applied(db);
	const known = new Set(scopes.map((s) => s.scope));

	const orphaned: MigrationPlan['orphaned'] = [];
	for (const [scope, names] of done) {
		if (!known.has(scope)) orphaned.push({ scope, names });
	}

	const pending: MigrationPlan['pending'] = [];
	for (const { scope, migrations } of scopes) {
		const codeNames = Object.keys(migrations).sort();
		const appliedNames = done.get(scope) ?? [];
		const unknown = appliedNames.filter((name) => !(name in migrations));
		if (unknown.length > 0) throw new SchemaNewerThanCodeError(scope, unknown);

		const last = appliedNames.at(-1);
		const appliedSet = new Set(appliedNames);
		for (const name of codeNames) {
			if (appliedSet.has(name)) continue;
			if (last !== undefined && name < last) throw new OutOfOrderMigrationError(scope, name, last);
			pending.push({ scope, name });
		}
	}
	return { pending, orphaned };
}

/** Applies pending migrations in scope order; each migration runs in its own transaction. */
export async function runMigrations(
	db: DbExecutor,
	scopes: readonly MigrationScope[],
	now: () => number = Date.now,
): Promise<MigrationPlan> {
	const plan = await planMigrations(db, scopes);
	const byScope = new Map(scopes.map((s) => [s.scope, s.migrations]));
	for (const { scope, name } of plan.pending) {
		const migration = byScope.get(scope)?.[name];
		if (!migration) throw new Error(`Missing migration ${scope}/${name}`);
		try {
			await db.transaction().execute(async (trx) => {
				await migration.up(trx);
				await trx
					.withTables<MigrationsTable>()
					.insertInto(TABLE)
					.values({ scope, name, applied_at: now() })
					.execute();
			});
		} catch (error) {
			throw new MigrationFailedError(scope, name, error);
		}
	}
	return plan;
}

/** Applied migration names per scope, recorded in backup manifests. */
export async function schemaState(db: DbExecutor): Promise<Record<string, string[]>> {
	await ensureTable(db);
	return Object.fromEntries(await applied(db));
}
