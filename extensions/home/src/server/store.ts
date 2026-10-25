import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';
import type { Home, Item, Service, ServiceKind, Tenure } from '../contract/index.ts';

/** Storage for home (tables prefixed `home_`). */
export type HomeTables = {
	home_homes: {
		id: string;
		name: string;
		address: string;
		tenure: Tenure;
		notes: string | null;
		created_by: string | null;
		created_at: number;
		updated_at: number;
		archived_at: number | null;
	};
	home_items: {
		id: string;
		home_id: string;
		name: string;
		room: string;
		brand: string;
		model: string;
		serial: string | null;
		purchased_on: string | null;
		warranty_until: string | null;
		/**
		 * The "Warranty ends" obligation in `records` (`obligation_…`) that follows
		 * `warranty_until`; no foreign key.
		 */
		warranty_obligation_id: string | null;
		notes: string | null;
		created_by: string | null;
		created_at: number;
		updated_at: number;
		archived_at: number | null;
	};
	home_services: {
		id: string;
		home_id: string;
		kind: ServiceKind;
		provider: string;
		account_number: string | null;
		due_day: number | null;
		notes: string | null;
		created_by: string | null;
		created_at: number;
		updated_at: number;
		archived_at: number | null;
	};
};
export type HomeRow = HomeTables['home_homes'];
export type ItemRow = HomeTables['home_items'];
export type ServiceRow = HomeTables['home_services'];

export const migrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('home_homes')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('name', 'text', (c) => c.notNull())
				.addColumn('address', 'text', (c) => c.notNull().defaultTo(''))
				.addColumn('tenure', 'text', (c) => c.notNull().defaultTo('owner'))
				.addColumn('notes', 'text')
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('archived_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('home_homes_active_idx')
				.on('home_homes')
				.columns(['archived_at', 'created_at'])
				.execute();

			await db.schema
				.createTable('home_items')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('home_id', 'text', (c) =>
					c.notNull().references('home_homes.id').onDelete('cascade'),
				)
				.addColumn('name', 'text', (c) => c.notNull())
				.addColumn('room', 'text', (c) => c.notNull().defaultTo(''))
				.addColumn('brand', 'text', (c) => c.notNull().defaultTo(''))
				.addColumn('model', 'text', (c) => c.notNull().defaultTo(''))
				.addColumn('serial', 'text')
				.addColumn('purchased_on', 'text')
				.addColumn('warranty_until', 'text')
				.addColumn('warranty_obligation_id', 'text')
				.addColumn('notes', 'text')
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('archived_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('home_items_home_idx')
				.on('home_items')
				.columns(['home_id', 'archived_at', 'created_at'])
				.execute();

			await db.schema
				.createTable('home_services')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('home_id', 'text', (c) =>
					c.notNull().references('home_homes.id').onDelete('cascade'),
				)
				.addColumn('kind', 'text', (c) => c.notNull().defaultTo('other'))
				.addColumn('provider', 'text', (c) => c.notNull())
				.addColumn('account_number', 'text')
				.addColumn('due_day', 'integer')
				.addColumn('notes', 'text')
				.addColumn('created_by', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.addColumn('archived_at', 'integer')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createIndex('home_services_home_idx')
				.on('home_services')
				.columns(['home_id', 'archived_at', 'created_at'])
				.execute();
		},
	},
};

export const tables = (db: DbExecutor) => db.withTables<HomeTables>();

export const toHome = (r: HomeRow): Home => ({
	id: r.id,
	name: r.name,
	address: r.address,
	tenure: r.tenure,
	notes: r.notes,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/**
 * `seePrivate` is whether the reader may edit the home: only then are the serial and the account
 * number theirs to see; everyone else with `home.view` gets null for them.
 */
export const toItem = (r: ItemRow, seePrivate: boolean): Item => ({
	id: r.id,
	homeId: r.home_id,
	name: r.name,
	room: r.room,
	brand: r.brand,
	model: r.model,
	serial: seePrivate ? r.serial : null,
	purchasedOn: r.purchased_on,
	warrantyUntil: r.warranty_until,
	notes: r.notes,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export const toService = (r: ServiceRow, seePrivate: boolean): Service => ({
	id: r.id,
	homeId: r.home_id,
	kind: r.kind,
	provider: r.provider,
	accountNumber: seePrivate ? r.account_number : null,
	dueDay: r.due_day,
	notes: r.notes,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});
