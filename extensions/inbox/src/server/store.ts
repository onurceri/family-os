import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';
import { z } from 'zod';
import {
	type ErrorCode,
	type ExtractionKind,
	type InboxItem,
	type ItemStatus,
	type Skip,
	SkipSchema,
} from '../contract/index.ts';

/** Storage for the Family Inbox (tables prefixed `inbox_`). */
export type InboxTables = {
	inbox_items: {
		id: string;
		channel: 'share' | 'upload' | 'text' | 'telegram' | 'email';
		title: string | null;
		text: string | null;
		url: string | null;
		/** JSON array of { key, name, type, size }; keys live under `inbox/<item id>/`. */
		files: string;
		status: ItemStatus;
		/** JSON { recordId, recordKind, label, recordName } when the item was filed on a record. */
		filed_to: string | null;
		/** Prepared text for the model (shared text plus text files). */
		normalized_text: string | null;
		/** Speech to text of the item's voice notes. */
		transcript: string | null;
		summary: string | null;
		/** What the model made of the item (`actionable`, `nothing`, `question`). */
		kind: ExtractionKind | null;
		error_code: ErrorCode | null;
		/** The attempt that comes next while a failed reading waits for its retry. */
		read_attempt: number | null;
		proposals: number;
		skipped: number;
		/** Of the skipped, those that pointed at a record that is not on the household's lists. */
		skipped_unknown: number;
		/** JSON array of { reason, subject }: each proposal left out, and why. */
		skips: string;
		/** `provider / model` of the last extraction. */
		model: string | null;
		/** Incremented on every retry, so drafts from a new extraction get new dedupe keys. */
		extraction: number;
		created_by: string | null;
		created_at: number;
		updated_at: number;
	};
};
/** The search kind of an inbox item (kept here so that items and search do not import each other). */
export const ITEM_KIND = 'inbox.item';

export type ItemRow = InboxTables['inbox_items'];
export type StoredFile = { key: string; name: string; type: string; size: number };

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('inbox_items')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('channel', 'text', (c) => c.notNull())
				.addColumn('title', 'text')
				.addColumn('text', 'text')
				.addColumn('url', 'text')
				.addColumn('files', 'text', (c) => c.notNull())
				.addColumn('status', 'text', (c) => c.notNull())
				.addColumn('normalized_text', 'text')
				.addColumn('summary', 'text')
				.addColumn('error_code', 'text')
				.addColumn('proposals', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('skipped', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('model', 'text')
				.addColumn('extraction', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('transcript', 'text')
				.addColumn('filed_to', 'text')
				.addColumn('kind', 'text')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('inbox_items_created_idx')
				.on('inbox_items')
				.columns(['created_at'])
				.execute();
		},
	},
	'0002_read_attempt': {
		async up(db) {
			await db.schema.alterTable('inbox_items').addColumn('read_attempt', 'integer').execute();
		},
	},
	'0003_skipped_unknown': {
		async up(db) {
			await db.schema
				.alterTable('inbox_items')
				.addColumn('skipped_unknown', 'integer', (c) => c.notNull().defaultTo(0))
				.execute();
		},
	},
	'0004_skips': {
		async up(db) {
			await db.schema
				.alterTable('inbox_items')
				.addColumn('skips', 'text', (c) => c.notNull().defaultTo('[]'))
				.execute();
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<InboxTables>();

export const filesOf = (row: ItemRow): StoredFile[] => JSON.parse(row.files) as StoredFile[];

const StoredSkipsSchema = z.array(SkipSchema);

/**
 * Why each proposal was left out. An item read before the reasons were kept has only its counts:
 * those it pointed at nothing real, and the rest, which were then all called incomplete.
 */
export function skipsOf(row: Pick<ItemRow, 'skips' | 'skipped' | 'skipped_unknown'>): Skip[] {
	let stored: Skip[] = [];
	try {
		const parsed = StoredSkipsSchema.safeParse(JSON.parse(row.skips));
		if (parsed.success) stored = parsed.data;
	} catch {
		// Not JSON: read as if no reasons were kept.
	}
	if (stored.length > 0 || row.skipped === 0) return stored;
	const unknown = Math.min(row.skipped_unknown, row.skipped);
	return [
		...Array.from({ length: unknown }, () => ({ reason: 'unknown' as const, subject: null })),
		...Array.from({ length: row.skipped - unknown }, () => ({
			reason: 'incomplete' as const,
			subject: null,
		})),
	];
}

export function toItem(row: ItemRow): InboxItem {
	return {
		id: row.id,
		channel: row.channel,
		title: row.title,
		text: row.text,
		url: row.url,
		files: filesOf(row).map(({ name, type, size }) => ({ name, type, size })),
		status: row.status,
		filedTo: row.filed_to ? (JSON.parse(row.filed_to) as InboxItem['filedTo']) : null,
		transcript: row.transcript,
		summary: row.summary,
		kind: row.kind,
		errorCode: row.error_code,
		attempt: row.read_attempt,
		proposals: row.proposals,
		skipped: row.skipped,
		skippedUnknown: row.skipped_unknown,
		skips: skipsOf(row),
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
