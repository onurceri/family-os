import type {
	ClaimedJob,
	Clock,
	DbExecutor,
	EnqueueOptions,
	IdGenerator,
	JobQueue,
	JobState,
	Migrations,
} from '@famos/sdk';
import { sql } from 'kysely';

/**
 * JobQueue on a table in the main SQLite database. Because `enqueue` uses the
 * caller's transaction, jobs commit or roll back together with the data they belong to.
 * Claiming is a single UPDATE … RETURNING, which is atomic under SQLite's single writer.
 */
type QueueTables = {
	queue_jobs: {
		id: string;
		name: string;
		payload: string;
		status: 'pending' | 'running' | 'succeeded' | 'dead';
		attempts: number;
		max_attempts: number;
		run_at: number;
		lease_until: number | null;
		last_error: string | null;
		dedupe_key: string | null;
		created_at: number;
		updated_at: number;
		finished_at: number | null;
	};
};

export const queueMigrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('queue_jobs')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('name', 'text', (c) => c.notNull())
				.addColumn('payload', 'text', (c) => c.notNull())
				.addColumn('status', 'text', (c) =>
					c.notNull().check(sql`status in ('pending', 'running', 'succeeded', 'dead')`),
				)
				.addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('max_attempts', 'integer', (c) => c.notNull())
				.addColumn('run_at', 'integer', (c) => c.notNull())
				.addColumn('lease_until', 'integer')
				.addColumn('last_error', 'text')
				.addColumn('dedupe_key', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('finished_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('queue_jobs_due_idx')
				.on('queue_jobs')
				.columns(['status', 'run_at'])
				.execute();
			await db.schema
				.createIndex('queue_jobs_dedupe_idx')
				.on('queue_jobs')
				.column('dedupe_key')
				.unique()
				.where(sql.ref('status'), 'in', ['pending', 'running'])
				.execute();
		},
	},
};

export interface SqliteQueueOptions {
	db: DbExecutor;
	clock: Clock;
	ids: IdGenerator;
	defaultMaxAttempts?: number;
}

export interface SqliteJobQueue extends JobQueue {
	/** Deletes finished jobs older than `olderThanMs`. Dead jobs are kept for inspection. */
	pruneSucceeded(olderThanMs: number): Promise<number>;
}

export function createSqliteQueue(options: SqliteQueueOptions): SqliteJobQueue {
	const { clock, ids } = options;
	const q = (db: DbExecutor) => db.withTables<QueueTables>();
	const db = q(options.db);
	const defaultMaxAttempts = options.defaultMaxAttempts ?? 5;

	return {
		async enqueue(executor, name, payload, opts: EnqueueOptions = {}) {
			const now = clock.now();
			const tx = q(executor);
			if (opts.dedupeKey) {
				const existing = await tx
					.selectFrom('queue_jobs')
					.select('id')
					.where('dedupe_key', '=', opts.dedupeKey)
					.where('status', 'in', ['pending', 'running'])
					.executeTakeFirst();
				if (existing) return existing.id;
			}
			const id = ids.next('job');
			await tx
				.insertInto('queue_jobs')
				.values({
					id,
					name,
					payload: JSON.stringify(payload ?? null),
					status: 'pending',
					attempts: 0,
					max_attempts: opts.maxAttempts ?? defaultMaxAttempts,
					run_at: opts.runAt ?? now,
					lease_until: null,
					last_error: null,
					dedupe_key: opts.dedupeKey ?? null,
					created_at: now,
					updated_at: now,
					finished_at: null,
				})
				.execute();
			return id;
		},

		async claim(names, leaseMs): Promise<ClaimedJob | undefined> {
			if (names.length === 0) return undefined;
			const now = clock.now();
			const lease =
				typeof leaseMs === 'number'
					? sql<number>`${now + leaseMs}`
					: sql<number>`${now} + case name ${sql.join(
							names.map((name) => sql`when ${name} then ${leaseMs(name)}`),
							sql` `,
						)} end`;
			const row = await db
				.updateTable('queue_jobs')
				.set((eb) => ({
					status: 'running',
					attempts: eb('attempts', '+', 1),
					lease_until: lease,
					updated_at: now,
				}))
				.where('id', '=', (eb) =>
					eb
						.selectFrom('queue_jobs')
						.select('id')
						.where('status', '=', 'pending')
						.where('run_at', '<=', now)
						.where('name', 'in', [...names])
						.orderBy('run_at')
						.orderBy('created_at')
						.limit(1),
				)
				.returning(['id', 'name', 'payload', 'attempts', 'max_attempts'])
				.executeTakeFirst();
			if (!row) return undefined;
			return {
				id: row.id,
				name: row.name,
				payload: JSON.parse(row.payload),
				attempt: row.attempts,
				maxAttempts: row.max_attempts,
			};
		},

		async complete(id) {
			const now = clock.now();
			await db
				.updateTable('queue_jobs')
				.set({ status: 'succeeded', lease_until: null, finished_at: now, updated_at: now })
				.where('id', '=', id)
				.execute();
		},

		async fail(id, error, retryAt): Promise<JobState> {
			const now = clock.now();
			const row = await db
				.updateTable('queue_jobs')
				.set((eb) => ({
					status: eb
						.case()
						.when('attempts', '>=', eb.ref('max_attempts'))
						.then('dead')
						.else('pending')
						.end()
						.$castTo<'dead' | 'pending'>(),
					run_at: retryAt,
					lease_until: null,
					last_error: error.slice(0, 4000),
					updated_at: now,
					finished_at: eb
						.case()
						.when('attempts', '>=', eb.ref('max_attempts'))
						.then(now)
						.else(null)
						.end(),
				}))
				.where('id', '=', id)
				.returning('status')
				.executeTakeFirst();
			return row?.status === 'dead' ? 'dead' : 'failed';
		},

		async recoverExpired() {
			const now = clock.now();
			const result = await db
				.updateTable('queue_jobs')
				.set((eb) => ({
					status: eb
						.case()
						.when('attempts', '>=', eb.ref('max_attempts'))
						.then('dead')
						.else('pending')
						.end()
						.$castTo<'dead' | 'pending'>(),
					lease_until: null,
					last_error: 'lease expired (worker stopped or crashed)',
					updated_at: now,
				}))
				.where('status', '=', 'running')
				.where('lease_until', '<', now)
				.executeTakeFirst();
			return Number(result.numUpdatedRows);
		},

		async pruneSucceeded(olderThanMs) {
			const result = await db
				.deleteFrom('queue_jobs')
				.where('status', '=', 'succeeded')
				.where('finished_at', '<', clock.now() - olderThanMs)
				.executeTakeFirst();
			return Number(result.numDeletedRows);
		},
	};
}
