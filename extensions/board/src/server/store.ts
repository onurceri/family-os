import { addVersion, bumpParentVersion, type DbExecutor, type Migrations } from '@famos/sdk';
import { type Generated, type Selectable, sql } from 'kysely';
import type { BoardNote, Paper } from '../contract/index.ts';

/** Storage for the family board (tables prefixed `board_`). */
export type BoardTables = {
	board_notes: {
		id: string;
		text: string;
		/** Key of the photo in the file store. */
		photo: string | null;
		photo_type: string | null;
		paper: Paper;
		/** 0 or 1. */
		pinned: number;
		/** The instant the note leaves the board; null keeps it. */
		ends_at: number | null;
		created_by: string | null;
		created_at: number;
		updated_at: number;
		/**
		 * Where the note stands among the notes of its group (pinned or not), smallest first; null for
		 * a note in a group nobody has arranged yet (those go newest first).
		 */
		position: number | null;
		/** Goes up by one on every write of the row (a trigger does it); what `ifMatch` compares. */
		version: Generated<number>;
	};
	board_note_seen: {
		note_id: string;
		member_id: string;
		seen_at: number;
	};
};
export type NoteRow = Selectable<BoardTables['board_notes']>;

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('board_notes')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('text', 'text', (c) => c.notNull())
				.addColumn('photo', 'text')
				.addColumn('photo_type', 'text')
				.addColumn('paper', 'text', (c) => c.notNull().defaultTo('note-1'))
				.addColumn('pinned', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('ends_at', 'integer')
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				// Fractional, so a note moves between two others by changing only its own row.
				.addColumn('position', 'real')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('board_notes_order_idx')
				.on('board_notes')
				.columns(['pinned', 'created_at'])
				.execute();
			await db.schema
				.createIndex('board_notes_ends_idx')
				.on('board_notes')
				.column('ends_at')
				.execute();

			await db.schema
				.createTable('board_note_seen')
				.addColumn('note_id', 'text', (c) =>
					c.notNull().references('board_notes.id').onDelete('cascade'),
				)
				.addColumn('member_id', 'text', (c) => c.notNull())
				.addColumn('seen_at', 'integer', (c) => c.notNull())
				.addPrimaryKeyConstraint('board_note_seen_pk', ['note_id', 'member_id'])
				.modifyEnd(sql`strict`)
				.execute();
		},
	},
	'0002_versions': {
		async up(db) {
			await addVersion(db, 'board_notes');
			// A note shows who has seen it.
			await bumpParentVersion(db, {
				parent: 'board_notes',
				child: 'board_note_seen',
				childKey: 'note_id',
			});
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<BoardTables>();

/** A note as the API shows it; `endsOn` is worked out in the family's time zone by the caller. */
export function toNote(row: NoteRow, seenBy: readonly string[], endsOn: string | null): BoardNote {
	return {
		id: row.id,
		version: row.version,
		text: row.text,
		paper: row.paper,
		pinned: row.pinned === 1,
		endsAt: row.ends_at,
		endsOn,
		hasPhoto: row.photo !== null,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		seenBy: [...seenBy],
	};
}
