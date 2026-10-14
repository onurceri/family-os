import type { Migration } from '@famos/sdk';
import { sql } from 'kysely';

/** Core's tables. Column types and meanings are documented in `../tables.ts`. */
export const m0001_init: Migration = {
	async up(db) {
		// `role_id` is a built-in role or a `core_roles` id.
		await db.schema
			.createTable('core_members')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('display_name', 'text', (c) => c.notNull())
			.addColumn('role_id', 'text', (c) => c.notNull())
			.addColumn('about', 'text')
			.addColumn('color', 'text', (c) => c.notNull())
			.addColumn('locale', 'text')
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addColumn('updated_at', 'integer', (c) => c.notNull())
			.addColumn('archived_at', 'integer')
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_members_role_idx')
			.on('core_members')
			.columns(['role_id'])
			.execute();

		await db.schema
			.createTable('core_roles')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('name', 'text', (c) => c.notNull())
			.addColumn('base', 'text', (c) =>
				c.notNull().check(sql`base in ('member', 'supervised', 'guest')`),
			)
			.addColumn('overrides', 'text', (c) => c.notNull())
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addColumn('updated_at', 'integer', (c) => c.notNull())
			.modifyEnd(sql`strict`)
			.execute();

		await db.schema
			.createTable('core_drafts')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('action_id', 'text', (c) => c.notNull())
			.addColumn('input', 'text', (c) => c.notNull())
			.addColumn('edited_input', 'text')
			.addColumn('status', 'text', (c) =>
				c
					.notNull()
					.check(
						sql`status in ('pending', 'approved', 'rejected', 'applied', 'failed', 'undone', 'expired')`,
					),
			)
			.addColumn('proposed_by', 'text', (c) => c.notNull())
			.addColumn('source_kind', 'text')
			.addColumn('source_id', 'text')
			.addColumn('summary', 'text')
			.addColumn('model', 'text')
			.addColumn('prompt_version', 'text')
			.addColumn('confidence', 'real')
			.addColumn('decided_by', 'text')
			.addColumn('decided_at', 'integer')
			.addColumn('applied_at', 'integer')
			.addColumn('result', 'text')
			.addColumn('error', 'text')
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addColumn('updated_at', 'integer', (c) => c.notNull())
			.addColumn('uncertain_fields', 'text')
			.addColumn('dedupe_key', 'text')
			.addColumn('auto_approved', 'integer', (c) => c.notNull().defaultTo(0))
			.addColumn('for_member', 'text')
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_drafts_status_idx')
			.on('core_drafts')
			.columns(['status', 'created_at'])
			.execute();
		await db.schema
			.createIndex('core_drafts_source_idx')
			.on('core_drafts')
			.columns(['source_kind', 'source_id'])
			.execute();
		// A proposer-chosen key makes drafting idempotent: a job that runs twice proposes once.
		await sql`create unique index core_drafts_dedupe_key_idx on core_drafts (dedupe_key) where dedupe_key is not null`.execute(
			db,
		);

		await db.schema
			.createTable('core_audit_log')
			.addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
			.addColumn('at', 'integer', (c) => c.notNull())
			.addColumn('actor', 'text', (c) => c.notNull())
			.addColumn('action_id', 'text', (c) => c.notNull())
			.addColumn('draft_id', 'text')
			.addColumn('outcome', 'text', (c) =>
				c.notNull().check(sql`outcome in ('applied', 'drafted', 'rejected', 'undone')`),
			)
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_audit_log_at_idx')
			.on('core_audit_log')
			.column('at')
			.execute();

		await db.schema
			.createTable('core_settings')
			.addColumn('key', 'text', (c) => c.primaryKey())
			.addColumn('value', 'text', (c) => c.notNull())
			.addColumn('updated_at', 'integer', (c) => c.notNull())
			.modifyEnd(sql`strict`)
			.execute();

		// Trusted family devices and displays. Only the SHA-256 of a device token is stored.
		await db.schema
			.createTable('core_devices')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('name', 'text', (c) => c.notNull())
			.addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('family', 'kiosk')`))
			.addColumn('token_hash', 'text', (c) => c.notNull().unique())
			.addColumn('created_by', 'text', (c) => c.notNull())
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addColumn('last_seen_at', 'integer', (c) => c.notNull())
			.addColumn('revoked_at', 'integer')
			.addColumn('display_capabilities', 'text')
			.addColumn('display_show_names', 'integer', (c) => c.notNull().defaultTo(0))
			.modifyEnd(sql`strict`)
			.execute();

		// Short-lived records that hand a display its token once an admin confirms its code.
		await db.schema
			.createTable('core_display_pairings')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('device_code_hash', 'text', (c) => c.notNull().unique())
			.addColumn('user_code', 'text', (c) => c.notNull())
			.addColumn('expires_at', 'integer', (c) => c.notNull())
			.addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
			.addColumn('status', 'text', (c) =>
				c.notNull().check(sql`status in ('pending', 'confirmed', 'consumed')`),
			)
			.addColumn('name', 'text')
			.addColumn('capabilities', 'text')
			.addColumn('show_names', 'integer', (c) => c.notNull().defaultTo(0))
			.addColumn('confirmed_by', 'text')
			.addColumn('device_id', 'text')
			.addColumn('created_ip', 'text')
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_display_pairings_user_code_idx')
			.on('core_display_pairings')
			.columns(['user_code'])
			.execute();

		// One row per recipient is the in-app record; preferences are one JSON document per member.
		await db.schema
			.createTable('core_notifications')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('member_id', 'text', (c) => c.notNull().references('core_members.id'))
			.addColumn('kind', 'text', (c) => c.notNull())
			.addColumn('title_key', 'text', (c) => c.notNull())
			.addColumn('title_params', 'text')
			.addColumn('body_key', 'text')
			.addColumn('body_params', 'text')
			.addColumn('url', 'text')
			.addColumn('source_kind', 'text')
			.addColumn('source_id', 'text')
			.addColumn('dedupe_key', 'text')
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addColumn('read_at', 'integer')
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_notifications_member_idx')
			.on('core_notifications')
			.columns(['member_id', 'created_at'])
			.execute();
		await db.schema
			.createIndex('core_notifications_dedupe_idx')
			.on('core_notifications')
			.columns(['member_id', 'dedupe_key'])
			.unique()
			.where(sql.ref('dedupe_key'), 'is not', null)
			.execute();

		await db.schema
			.createTable('core_notification_prefs')
			.addColumn('member_id', 'text', (c) => c.primaryKey().references('core_members.id'))
			.addColumn('prefs', 'text', (c) => c.notNull())
			.addColumn('updated_at', 'integer', (c) => c.notNull())
			.modifyEnd(sql`strict`)
			.execute();

		// Personal API tokens for MCP clients; only the SHA-256 of a token is stored. MCP is
		// stateless, so the handle table remembers which ids a token was shown as which handles.
		await db.schema
			.createTable('core_api_tokens')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('member_id', 'text', (c) => c.notNull().references('core_members.id'))
			.addColumn('name', 'text', (c) => c.notNull())
			.addColumn('token_hash', 'text', (c) => c.notNull().unique())
			.addColumn('scope', 'text', (c) => c.notNull().check(sql`scope in ('read', 'read_write')`))
			.addColumn('expires_at', 'integer')
			.addColumn('last_used_at', 'integer')
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addColumn('revoked_at', 'integer')
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_api_tokens_member_idx')
			.on('core_api_tokens')
			.column('member_id')
			.execute();

		await db.schema
			.createTable('core_api_token_handles')
			.addColumn('token_id', 'text', (c) =>
				c.notNull().references('core_api_tokens.id').onDelete('cascade'),
			)
			.addColumn('handle', 'text', (c) => c.notNull())
			.addColumn('ref_id', 'text', (c) => c.notNull())
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addPrimaryKeyConstraint('core_api_token_handles_pk', ['token_id', 'handle'])
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_api_token_handles_created_idx')
			.on('core_api_token_handles')
			.columns(['token_id', 'created_at'])
			.execute();

		// Results of requests that carried an `Idempotency-Key`, per member; a daily job deletes
		// rows older than 7 days.
		await db.schema
			.createTable('core_idempotency')
			.addColumn('key', 'text', (c) => c.notNull())
			.addColumn('member_id', 'text', (c) => c.notNull())
			.addColumn('action_id', 'text', (c) => c.notNull())
			.addColumn('status', 'integer', (c) => c.notNull())
			.addColumn('response', 'text', (c) => c.notNull())
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addPrimaryKeyConstraint('core_idempotency_pk', ['member_id', 'key'])
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_idempotency_created_idx')
			.on('core_idempotency')
			.column('created_at')
			.execute();

		// Family search: one row per chunk of text with its vector (little-endian float32, unit
		// length, so a dot product is the cosine). `text_hash` lets an unchanged chunk skip the
		// model; `model` lets a model change rebuild everything. The table can always be rebuilt
		// from the extensions' data.
		await db.schema
			.createTable('core_embeddings')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('extension_id', 'text', (c) => c.notNull())
			.addColumn('source_kind', 'text', (c) => c.notNull())
			.addColumn('source_id', 'text', (c) => c.notNull())
			.addColumn('capability', 'text', (c) => c.notNull())
			.addColumn('owner_member_id', 'text')
			.addColumn('title', 'text', (c) => c.notNull())
			.addColumn('href', 'text', (c) => c.notNull())
			.addColumn('snippet', 'text', (c) => c.notNull())
			.addColumn('model', 'text', (c) => c.notNull())
			.addColumn('dimensions', 'integer', (c) => c.notNull())
			.addColumn('text_hash', 'text', (c) => c.notNull())
			.addColumn('chunk_index', 'integer', (c) => c.notNull())
			.addColumn('vector', 'blob', (c) => c.notNull())
			.addColumn('updated_at', 'integer', (c) => c.notNull())
			.addUniqueConstraint('core_embeddings_chunk_uq', ['source_kind', 'source_id', 'chunk_index'])
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_embeddings_extension_idx')
			.on('core_embeddings')
			.column('extension_id')
			.execute();

		// Short notes a member owns, shown to the assistant in that member's own threads only.
		await db.schema
			.createTable('core_member_memory')
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('member_id', 'text', (c) => c.notNull())
			.addColumn('text', 'text', (c) => c.notNull())
			.addColumn('source', 'text', (c) => c.notNull())
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addColumn('updated_at', 'integer', (c) => c.notNull())
			.modifyEnd(sql`strict`)
			.execute();
		await db.schema
			.createIndex('core_member_memory_member_idx')
			.on('core_member_memory')
			.columns(['member_id', 'updated_at'])
			.execute();
	},
};

/**
 * A pending draft can become another action (a new event becomes a change of the one already on
 * the calendar): the draft keeps what it proposed before, and the audit log records the switch.
 * SQLite cannot change a check constraint, so the audit log is rebuilt with its rows.
 */
export const m0002_draft_replaced: Migration = {
	async up(db) {
		await db.schema.alterTable('core_drafts').addColumn('replaced', 'text').execute();
		await db.schema
			.createTable('core_audit_log_next')
			.addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
			.addColumn('at', 'integer', (c) => c.notNull())
			.addColumn('actor', 'text', (c) => c.notNull())
			.addColumn('action_id', 'text', (c) => c.notNull())
			.addColumn('draft_id', 'text')
			.addColumn('outcome', 'text', (c) =>
				c.notNull().check(sql`outcome in ('applied', 'drafted', 'rejected', 'undone', 'replaced')`),
			)
			.modifyEnd(sql`strict`)
			.execute();
		await sql`insert into core_audit_log_next (id, at, actor, action_id, draft_id, outcome)
			select id, at, actor, action_id, draft_id, outcome from core_audit_log`.execute(db);
		await db.schema.dropTable('core_audit_log').execute();
		await db.schema.alterTable('core_audit_log_next').renameTo('core_audit_log').execute();
		await db.schema
			.createIndex('core_audit_log_at_idx')
			.on('core_audit_log')
			.column('at')
			.execute();
	},
};

/**
 * AI actors say how they work (`mode`) instead of core recognising extensions by name. Stored
 * actors get the mode their source had: the names below are the extensions and doors that
 * existed when this ran, and this migration is the only place core names them. A memory the AI
 * proposed is marked `ai`.
 */
export const m0003_ai_mode: Migration = {
	async up(db) {
		await sql`update core_member_memory set source = 'ai' where source = 'assistant'`.execute(db);
		for (const table of ['core_drafts', 'core_audit_log'] as const) {
			const column = table === 'core_drafts' ? 'proposed_by' : 'actor';
			await sql`update ${sql.table(table)} set ${sql.ref(column)} = json_set(${sql.ref(column)}, '$.mode',
				case json_extract(${sql.ref(column)}, '$.source')
					when 'inbox' then 'share'
					when 'assistant' then 'conversation'
					else 'agent'
				end)
				where json_valid(${sql.ref(column)})
					and json_extract(${sql.ref(column)}, '$.kind') = 'ai'
					and json_extract(${sql.ref(column)}, '$.mode') is null`.execute(db);
		}
	},
};

/**
 * An extension reads another's file only when the owner granted it. Papers filed on a record
 * before grants existed stay where the Inbox stored them, so they are granted to records here:
 * `records_documents` and `inbox/` are what existed when this ran, and this migration is the only
 * place core names them. Core migrates first, so on a new installation the table is not there yet
 * and nothing is granted (the Inbox grants each file it hands to records from now on).
 */
export const m0004_file_grants: Migration = {
	async up(db) {
		await db.schema
			.createTable('core_file_grants')
			.addColumn('key', 'text', (c) => c.notNull())
			.addColumn('grantee', 'text', (c) => c.notNull())
			.addColumn('created_at', 'integer', (c) => c.notNull())
			.addPrimaryKeyConstraint('core_file_grants_pk', ['key', 'grantee'])
			.modifyEnd(sql`strict`)
			.execute();
		const filed = await sql<{ n: number }>`select count(*) as n from sqlite_master
			where type = 'table' and name = 'records_documents'`.execute(db);
		if (!filed.rows[0]?.n) return;
		await sql`insert or ignore into core_file_grants (key, grantee, created_at)
			select distinct file_key, 'records', created_at from records_documents
			where file_key like 'inbox/%'`.execute(db);
	},
};

export const coreMigrations = {
	'0001_init': m0001_init,
	'0002_draft_replaced': m0002_draft_replaced,
	'0003_ai_mode': m0003_ai_mode,
	'0004_file_grants': m0004_file_grants,
};
