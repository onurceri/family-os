import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';

/** Storage for chat threads (tables prefixed `assistant_`). Threads are per member. */
export type AssistantTables = {
	assistant_threads: {
		id: string;
		member_id: string;
		title: string;
		/** What older messages said, written by the summariser; the newest stay verbatim. */
		summary: string | null;
		/** How many of the oldest messages the summary covers. */
		summarized_count: number;
		/**
		 * JSON: the handles the model was shown in earlier turns, `{ "event:1": { id, label } }`,
		 * so "move it" in the next turn still points at the same record.
		 */
		handles: string | null;
		created_at: number;
		updated_at: number;
	};
	assistant_messages: {
		id: string;
		thread_id: string;
		role: 'user' | 'assistant';
		content: string;
		/** JSON: the tools used (names and outcome only) and the drafts created. Never inputs. */
		tool_calls: string | null;
		/**
		 * JSON: the app's own line for each suggestion the answer made ("Suggested, not added yet:
		 * …"), kept apart from the model's words so a page that shows the suggestions as cards does
		 * not say them twice.
		 */
		suggested: string | null;
		status: 'pending' | 'streaming' | 'done' | 'failed';
		error_code: string | null;
		created_at: number;
	};
};
export type ThreadRow = AssistantTables['assistant_threads'];
export type MessageRow = AssistantTables['assistant_messages'];

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('assistant_threads')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('member_id', 'text', (c) => c.notNull())
				.addColumn('title', 'text', (c) => c.notNull())
				.addColumn('summary', 'text')
				.addColumn('summarized_count', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('assistant_threads_member_idx')
				.on('assistant_threads')
				.columns(['member_id', 'updated_at'])
				.execute();
			await db.schema
				.createTable('assistant_messages')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('thread_id', 'text', (c) => c.notNull().references('assistant_threads.id'))
				.addColumn('role', 'text', (c) => c.notNull())
				.addColumn('content', 'text', (c) => c.notNull())
				.addColumn('tool_calls', 'text')
				.addColumn('status', 'text', (c) => c.notNull())
				.addColumn('error_code', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('assistant_messages_thread_idx')
				.on('assistant_messages')
				.columns(['thread_id', 'created_at'])
				.execute();
		},
	},
	'0002_thread_handles': {
		async up(db) {
			await db.schema.alterTable('assistant_threads').addColumn('handles', 'text').execute();
		},
	},
	'0003_message_suggested': {
		async up(db) {
			await db.schema.alterTable('assistant_messages').addColumn('suggested', 'text').execute();
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<AssistantTables>();
