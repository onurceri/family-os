import { addVersion, bumpParentVersion, type DbExecutor, type Migrations } from '@famos/sdk';
import type { Recurrence } from '@famos/time';
import { type Generated, type Selectable, sql } from 'kysely';
import type { Rotation } from '../contract/index.ts';

/** Storage for chores (tables prefixed `chores_`). */
export type ChoresTables = {
	chores_chores: {
		id: string;
		title: string;
		notes: string | null;
		/** JSON of a `Recurrence`; null for a one-off chore. */
		recurrence: string | null;
		start_date: string;
		/** Null once a one-off chore is done. */
		next_due: string | null;
		rotation: Rotation;
		/** Who is up now; null means anyone. No foreign key. */
		assignee_id: string | null;
		created_by: string | null;
		created_at: number;
		updated_at: number;
		archived_at: number | null;
		/** Goes up by one on every write of the row (a trigger does it); what `ifMatch` compares. */
		version: Generated<number>;
	};
	/** The people in rotation order. */
	chores_assignees: {
		chore_id: string;
		member_id: string;
		position: number;
	};
	chores_completions: {
		id: string;
		chore_id: string;
		/** Who did it. */
		member_id: string;
		/** The due date it completed. */
		due_date: string;
		/** Who was up before this completion, so an undo can put it back. */
		prev_assignee_id: string | null;
		done_at: number;
		undone_at: number | null;
	};
};
export type ChoreRow = Selectable<ChoresTables['chores_chores']>;
export type CompletionRow = ChoresTables['chores_completions'];

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('chores_chores')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('title', 'text', (c) => c.notNull())
				.addColumn('notes', 'text')
				.addColumn('recurrence', 'text')
				.addColumn('start_date', 'text', (c) => c.notNull())
				.addColumn('next_due', 'text')
				.addColumn('rotation', 'text', (c) =>
					c
						.notNull()
						.defaultTo('fixed')
						.check(sql`rotation in ('fixed', 'round_robin', 'least_done')`),
				)
				.addColumn('assignee_id', 'text')
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('archived_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('chores_chores_active_idx')
				.on('chores_chores')
				.columns(['archived_at', 'next_due'])
				.execute();

			await db.schema
				.createTable('chores_assignees')
				.addColumn('chore_id', 'text', (c) =>
					c.notNull().references('chores_chores.id').onDelete('cascade'),
				)
				.addColumn('member_id', 'text', (c) => c.notNull())
				.addColumn('position', 'integer', (c) => c.notNull())
				.addPrimaryKeyConstraint('chores_assignees_pk', ['chore_id', 'member_id'])
				.modifyEnd(sql`strict`)
				.execute();

			await db.schema
				.createTable('chores_completions')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('chore_id', 'text', (c) =>
					c.notNull().references('chores_chores.id').onDelete('cascade'),
				)
				.addColumn('member_id', 'text', (c) => c.notNull())
				.addColumn('due_date', 'text', (c) => c.notNull())
				.addColumn('prev_assignee_id', 'text')
				.addColumn('done_at', 'integer', (c) => c.notNull())
				.addColumn('undone_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			// One live completion per chore and due date; an undone one leaves room for a new one.
			await sql`create unique index chores_completions_live_idx
				on chores_completions (chore_id, due_date) where undone_at is null`.execute(db);
			await db.schema
				.createIndex('chores_completions_member_idx')
				.on('chores_completions')
				.columns(['member_id', 'done_at'])
				.execute();
		},
	},
	'0002_versions': {
		async up(db) {
			await addVersion(db, 'chores_chores');
			// A chore shows its people in turn order and its latest completion.
			await bumpParentVersion(db, {
				parent: 'chores_chores',
				child: 'chores_assignees',
				childKey: 'chore_id',
			});
			await bumpParentVersion(db, {
				parent: 'chores_chores',
				child: 'chores_completions',
				childKey: 'chore_id',
			});
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<ChoresTables>();

export const parseRecurrence = (row: Pick<ChoreRow, 'recurrence'>): Recurrence | null =>
	row.recurrence ? (JSON.parse(row.recurrence) as Recurrence) : null;
