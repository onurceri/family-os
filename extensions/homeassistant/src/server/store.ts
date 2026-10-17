import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';
import type { ConnectionStatus } from '../contract/index.ts';

/** Storage for the Home Assistant connection (tables prefixed `homeassistant_`). */
export type HomeAssistantTables = {
	/** At most one row (`id = 'home'`): the family has one Home Assistant. */
	homeassistant_connection: {
		id: string;
		/** Normalized address, without a trailing slash or `/api`. Not a secret. */
		base_url: string;
		/** The long-lived access token, sealed. Opened only by the check job. */
		sealed_token: string;
		status: ConnectionStatus;
		checked_at: number | null;
		/** Home Assistant's own version, from the check. */
		ha_version: string | null;
		/** Home Assistant's `location_name`. */
		ha_name: string | null;
		created_at: number;
		/** Moves on every change; a check only writes if it has not moved since it started. */
		updated_at: number;
	};
};

export const CONNECTION_ID = 'home';

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('homeassistant_connection')
				.addColumn('id', 'text', (c) => c.primaryKey().check(sql`id = 'home'`))
				.addColumn('base_url', 'text', (c) => c.notNull())
				.addColumn('sealed_token', 'text', (c) => c.notNull())
				// No CHECK on the status: a released migration never changes, and a new status would
				// otherwise need the table rebuilt. The code only ever writes a known one.
				.addColumn('status', 'text', (c) => c.notNull())
				.addColumn('checked_at', 'integer')
				.addColumn('ha_version', 'text')
				.addColumn('ha_name', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<HomeAssistantTables>();
