import type { DbExecutor, Migrations } from '@famos/sdk';
import { sql } from 'kysely';
import type { ProviderKind } from './schemas.ts';

/** Tables of the AI adapter (migration scope `ai`). */
export type AiTables = {
	ai_providers: {
		id: string;
		name: string;
		kind: ProviderKind;
		base_url: string;
		/** Sealed with the SecretBox; never stored or logged in plain text. */
		api_key: string | null;
		created_at: number;
		updated_at: number;
	};
	ai_settings: {
		key: 'roles' | 'limits' | 'privacy' | 'switches';
		value: string;
		updated_at: number;
	};
	ai_usage: {
		id: string;
		at: number;
		role: string;
		provider_id: string | null;
		/** `provider name / model` at the time of the call. */
		model: string;
		feature: string;
		member_id: string | null;
		job_id: string | null;
		input_tokens: number | null;
		output_tokens: number | null;
		/** The part of the output spent on thinking, when the provider reported it. */
		reasoning_tokens: number | null;
		/** Why the model stopped (`stop`, `length` …), when it answered. */
		finish_reason: string | null;
		/** Millionths of a USD, when known. */
		cost_micros: number | null;
		latency_ms: number;
		error_code: string | null;
		/** JSON array of the areas (extension ids) that contributed data. */
		areas: string | null;
	};
};

export const aiTables = (db: DbExecutor) => db.withTables<AiTables>();

export const aiMigrations: Migrations = {
	'0001_init': {
		async up(db) {
			await db.schema
				.createTable('ai_providers')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('name', 'text', (c) => c.notNull())
				.addColumn('kind', 'text', (c) => c.notNull())
				.addColumn('base_url', 'text', (c) => c.notNull())
				.addColumn('api_key', 'text')
				.addColumn('created_at', 'integer', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createTable('ai_settings')
				.addColumn('key', 'text', (c) => c.primaryKey())
				.addColumn('value', 'text', (c) => c.notNull())
				.addColumn('updated_at', 'integer', (c) => c.notNull())
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema
				.createTable('ai_usage')
				.addColumn('id', 'text', (c) => c.primaryKey())
				.addColumn('at', 'integer', (c) => c.notNull())
				.addColumn('role', 'text', (c) => c.notNull())
				.addColumn('provider_id', 'text')
				.addColumn('model', 'text', (c) => c.notNull())
				.addColumn('feature', 'text', (c) => c.notNull())
				.addColumn('member_id', 'text')
				.addColumn('job_id', 'text')
				.addColumn('input_tokens', 'integer')
				.addColumn('output_tokens', 'integer')
				.addColumn('cost_micros', 'integer')
				.addColumn('latency_ms', 'integer', (c) => c.notNull())
				.addColumn('error_code', 'text')
				.addColumn('areas', 'text')
				.modifyEnd(sql`strict`)
				.execute();
			await db.schema.createIndex('ai_usage_at_idx').on('ai_usage').columns(['at']).execute();
		},
	},
	'0002_usage_reasoning': {
		async up(db) {
			await db.schema.alterTable('ai_usage').addColumn('reasoning_tokens', 'integer').execute();
			await db.schema.alterTable('ai_usage').addColumn('finish_reason', 'text').execute();
		},
	},
};
