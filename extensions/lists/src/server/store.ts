import { addVersion, bumpParentVersion, type DbExecutor, type Migrations } from '@famos/sdk';
import { fromRRule, type Recurrence } from '@famos/time';
import { type Generated, type Selectable, sql } from 'kysely';
import type { Category, ShoppingItem, Task } from '../contract/index.ts';

/** Storage for tasks and shopping (tables prefixed `lists_`). */
export type ListsTables = {
	lists_tasks: {
		id: string;
		title: string;
		notes: string | null;
		/** Null = anyone. */
		assignee_id: string | null;
		/** Next due date (YYYY-MM-DD); moves forward when a repeating task is completed. */
		due_date: string | null;
		due_time: string | null;
		/** RRULE of a repeating task; expanded on dates from `rrule_start`. */
		rrule: string | null;
		/** First due date of the series (DTSTART), so moving `due_date` never shifts the rule. */
		rrule_start: string | null;
		done_at: number | null;
		done_by: string | null;
		created_by: string | null;
		source_kind: string | null;
		source_id: string | null;
		created_at: number;
		updated_at: number;
		deleted_at: number | null;
		/** Goes up by one on every write of the row (a trigger does it); what `ifMatch` compares. */
		version: Generated<number>;
	};
	/** Every completion, so a repeating task can be reopened (Undo) and shows history later. */
	lists_task_completions: {
		id: string;
		task_id: string;
		/** The due date that was completed (null for undated tasks). */
		due_date: string | null;
		done_at: number;
		done_by: string | null;
	};
	lists_shopping_lists: {
		id: string;
		name: string;
		sort: number;
		created_at: number;
		updated_at: number;
		archived_at: number | null;
		/** Goes up by one on every write of the row (a trigger does it); what `ifMatch` compares. */
		version: Generated<number>;
	};
	lists_shopping_items: {
		id: string;
		list_id: string;
		title: string;
		/** Normalized title for de-duplication and category memory. */
		title_key: string;
		quantity: string | null;
		category: Category;
		done_at: number | null;
		done_by: string | null;
		added_by: string | null;
		source_kind: string | null;
		source_id: string | null;
		created_at: number;
		updated_at: number;
		deleted_at: number | null;
		/** Goes up by one on every write of the row (a trigger does it); what `ifMatch` compares. */
		version: Generated<number>;
	};
};
export type TaskRow = Selectable<ListsTables['lists_tasks']>;
export type ItemRow = Selectable<ListsTables['lists_shopping_items']>;

/**
 * The list created on install, so shopping works before anyone sets lists up. Its name stays
 * empty until someone renames it: screens show a translated default (`default_list`).
 */
export const DEFAULT_LIST_ID = 'shop_list_00000000-0000-7000-8000-000000000001';

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('lists_tasks')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('title', 'text', (c) => c.notNull())
				.addColumn('notes', 'text')
				.addColumn('assignee_id', 'text')
				.addColumn('due_date', 'text')
				.addColumn('due_time', 'text')
				.addColumn('rrule', 'text')
				.addColumn('rrule_start', 'text')
				.addColumn('done_at', 'integer')
				.addColumn('done_by', 'text')
				.addColumn('created_by', 'text')
				.addColumn('source_kind', 'text')
				.addColumn('source_id', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('deleted_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('lists_tasks_due_idx')
				.on('lists_tasks')
				.columns(['done_at', 'due_date'])
				.execute();

			await db.schema
				.createTable('lists_task_completions')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('task_id', 'text', (c) => c.notNull().references('lists_tasks.id'))
				.addColumn('due_date', 'text')
				.addColumn('done_at', 'integer', (c) => c.notNull())
				.addColumn('done_by', 'text')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('lists_task_completions_task_idx')
				.on('lists_task_completions')
				.columns(['task_id', 'done_at'])
				.execute();

			await db.schema
				.createTable('lists_shopping_lists')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('name', 'text', (c) => c.notNull())
				.addColumn('sort', 'integer', (c) => c.notNull())
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('archived_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();

			await db.schema
				.createTable('lists_shopping_items')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('list_id', 'text', (c) => c.notNull().references('lists_shopping_lists.id'))
				.addColumn('title', 'text', (c) => c.notNull())
				.addColumn('title_key', 'text', (c) => c.notNull())
				.addColumn('quantity', 'text')
				.addColumn('category', 'text', (c) => c.notNull())
				.addColumn('done_at', 'integer')
				.addColumn('done_by', 'text')
				.addColumn('added_by', 'text')
				.addColumn('source_kind', 'text')
				.addColumn('source_id', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('deleted_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('lists_shopping_items_list_idx')
				.on('lists_shopping_items')
				.columns(['list_id', 'done_at'])
				.execute();
			await db.schema
				.createIndex('lists_shopping_items_key_idx')
				.on('lists_shopping_items')
				.columns(['title_key', 'updated_at'])
				.execute();

			const now = Date.now();
			await sql`insert into lists_shopping_lists (id, name, sort, created_at, updated_at) values (${DEFAULT_LIST_ID}, '', 0, ${now}, ${now})`.execute(
				db,
			);
		},
	},
	'0002_versions': {
		async up(db) {
			await addVersion(db, 'lists_tasks');
			await addVersion(db, 'lists_shopping_lists');
			await addVersion(db, 'lists_shopping_items');
			// A list shows how many of its items are open.
			await bumpParentVersion(db, {
				parent: 'lists_shopping_lists',
				child: 'lists_shopping_items',
				childKey: 'list_id',
			});
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<ListsTables>();

export { titleKey } from '../contract/index.ts';

export function toTask(row: TaskRow): Task {
	const recurrence: Recurrence | null = row.rrule ? fromRRule(row.rrule, 'UTC') : null;
	return {
		id: row.id,
		title: row.title,
		notes: row.notes,
		assigneeId: row.assignee_id,
		dueDate: row.due_date,
		dueTime: row.due_time,
		recurrence,
		rrule: row.rrule && !recurrence ? row.rrule : null,
		doneAt: row.done_at,
		doneBy: row.done_by,
	};
}

export function toItem(row: ItemRow): ShoppingItem {
	return {
		id: row.id,
		listId: row.list_id,
		title: row.title,
		quantity: row.quantity,
		category: row.category,
		doneAt: row.done_at,
		addedBy: row.added_by,
	};
}
