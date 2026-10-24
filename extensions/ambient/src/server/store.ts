import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';
import { type StoredSettings, StoredSettingsSchema } from '../contract/index.ts';

/** Storage for display content settings (tables prefixed `ambient_`). */
export type AmbientTables = {
	/** A single row (`id = 'main'`): the settings as JSON, validated by `StoredSettingsSchema`. */
	ambient_settings: {
		id: string;
		data: string;
		/** Bumped on every change; in-memory caches are dropped when it moves. */
		version: number;
		updated_at: number;
	};
	/** Photos the family uploaded for displays; the file itself is in the file store. */
	ambient_photos: {
		id: string;
		file_key: string;
		content_type: string;
		width: number;
		height: number;
		byte_size: number;
		/** Member id (no foreign key across extensions); null when not a member. */
		uploaded_by: string | null;
		created_at: number;
	};
};

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('ambient_settings')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('data', 'text', (c) => c.notNull())
				.addColumn('version', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createTable('ambient_photos')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('file_key', 'text', (c) => c.notNull())
				.addColumn('content_type', 'text', (c) => c.notNull())
				.addColumn('width', 'integer', (c) => c.notNull())
				.addColumn('height', 'integer', (c) => c.notNull())
				.addColumn('byte_size', 'integer', (c) => c.notNull())
				.addColumn('uploaded_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('ambient_photos_created')
				.on('ambient_photos')
				.column('created_at')
				.execute();
		},
	},
	'0002_photo_file_unique': {
		async up(db) {
			// Rows that share a file keep the oldest (the lowest id on a tie); the file stays.
			await sql`delete from ambient_photos where id in (
				select id from (
					select id, row_number() over (
						partition by file_key order by created_at asc, id asc
					) as n from ambient_photos
				) where n > 1
			)`.execute(db);
			await db.schema
				.createIndex('ambient_photos_file_key')
				.unique()
				.on('ambient_photos')
				.column('file_key')
				.execute();
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<AmbientTables>();

const ROW_ID = 'main';

export interface LoadedSettings {
	settings: StoredSettings;
	version: number;
}

/** The settings (defaults when nothing was saved yet). */
export async function loadSettings(db: DbExecutor): Promise<LoadedSettings> {
	const row = await tables(db)
		.selectFrom('ambient_settings')
		.select(['data', 'version'])
		.where('id', '=', ROW_ID)
		.executeTakeFirst();
	if (!row) return { settings: StoredSettingsSchema.parse({}), version: 0 };
	const parsed = StoredSettingsSchema.safeParse(JSON.parse(row.data));
	return {
		settings: parsed.success ? parsed.data : StoredSettingsSchema.parse({}),
		version: row.version,
	};
}

export async function saveSettings(
	db: DbExecutor,
	settings: StoredSettings,
	version: number,
	now: number,
): Promise<void> {
	const data = JSON.stringify(StoredSettingsSchema.parse(settings));
	await tables(db)
		.insertInto('ambient_settings')
		.values({ id: ROW_ID, data, version: version + 1, updated_at: now })
		.onConflict((oc) =>
			oc.column('id').doUpdateSet({ data, version: version + 1, updated_at: now }),
		)
		.execute();
}
