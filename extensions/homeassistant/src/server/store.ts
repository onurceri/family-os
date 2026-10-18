import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';
import type { ConnectionStatus, SharingLevel } from '../contract/index.ts';

/** Storage for the Home Assistant connection (tables prefixed `homeassistant_`). */
export type HomeAssistantTables = {
	/** At most one row (`id = 'home'`): the family has one Home Assistant. */
	homeassistant_connection: {
		id: string;
		/** Normalized address, without a trailing slash or `/api`. Not a secret. */
		base_url: string;
		/** The long-lived access token, sealed: opened to read, and to switch what the family allowed. */
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
	/** What the family chose to show; the entity is read live and never stored. */
	homeassistant_items: {
		id: string;
		/** An entity (never a person, a tracker or a zone), once. */
		entity_id: string;
		label: string;
		/** 0, 1, 2 … in the order shown. */
		position: number;
		/** 1: the family allowed switching it from FamilyOS. Off until someone turns it on. */
		control: number;
		/** 1: ask before switching it. On until someone turns it off. */
		confirm: number;
		created_at: number;
		updated_at: number;
	};
	/** Who switched what and how it went; short-lived, and never more than the last few weeks. */
	homeassistant_switches: {
		/** The job's id: a job that runs twice writes once. */
		id: string;
		/** The item, which may have been removed since (no foreign key: the history outlives it). */
		item_id: string;
		entity_id: string;
		/** The family's name for the item at the time. */
		label: string;
		operation: string;
		/** A member's id (members are core's: no foreign key); null when no member asked. */
		member_id: string | null;
		/** 1: Home Assistant took the order. */
		ok: number;
		at: number;
	};
	/**
	 * Which Home Assistant person a member is, and what that member chose to show about it. Only
	 * the choice is kept: never where they are or were.
	 */
	homeassistant_people: {
		/** A member's id (members are core's: no foreign key). */
		member_id: string;
		/** A `person.` entity, linked to one member at most. */
		person_entity: string;
		/** The member's own choice; `none` until they make one. */
		level: SharingLevel;
		/** 1: family displays granted presence show it too (the member's own choice). */
		on_displays: number;
		created_at: number;
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
	'0002_items': {
		async up(db) {
			await db.schema
				.createTable('homeassistant_items')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('entity_id', 'text', (c) => c.notNull().unique())
				.addColumn('label', 'text', (c) => c.notNull())
				.addColumn('position', 'integer', (c) => c.notNull())
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
		},
	},
	'0003_people': {
		async up(db) {
			await db.schema
				.createTable('homeassistant_people')
				.addColumn('member_id', 'text', (c) => c.primaryKey())
				.addColumn('person_entity', 'text', (c) => c.notNull().unique())
				// No CHECK on the level, for the same reason as the connection's status.
				.addColumn('level', 'text', (c) => c.notNull().defaultTo('none'))
				.addColumn('on_displays', 'integer', (c) => c.notNull().defaultTo(0))
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
		},
	},
	'0004_control': {
		async up(db) {
			await db.schema
				.alterTable('homeassistant_items')
				.addColumn('control', 'integer', (c) => c.notNull().defaultTo(0))
				.execute();
			await db.schema
				.alterTable('homeassistant_items')
				.addColumn('confirm', 'integer', (c) => c.notNull().defaultTo(1))
				.execute();
		},
	},
	'0005_switches': {
		async up(db) {
			await db.schema
				.createTable('homeassistant_switches')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('item_id', 'text', (c) => c.notNull())
				.addColumn('entity_id', 'text', (c) => c.notNull())
				.addColumn('label', 'text', (c) => c.notNull())
				.addColumn('operation', 'text', (c) => c.notNull())
				.addColumn('member_id', 'text')
				.addColumn('ok', 'integer', (c) => c.notNull())
				.addColumn('at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('homeassistant_switches_item_at')
				.on('homeassistant_switches')
				.columns(['item_id', 'at'])
				.execute();
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<HomeAssistantTables>();
