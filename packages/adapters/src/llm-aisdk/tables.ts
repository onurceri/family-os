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
		/** How a structured answer was asked for (`schema`, `json`, `text`); null for other calls. */
		output_mode: string | null;
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
	'0003_usage_output_mode': {
		async up(db) {
			await db.schema.alterTable('ai_usage').addColumn('output_mode', 'text').execute();
		},
	},
	/**
	 * "Only providers that keep no data" used to be on unless a family turned it off, and is now
	 * off unless they turn it on. A family that already uses AI keeps what it had: the privacy
	 * choice it never saved is written down as it was. A new install has nothing in these tables
	 * yet and gets the new default.
	 */
	'0004_keep_zero_retention': {
		async up(db) {
			const ai = aiTables(db);
			const privacy = await ai
				.selectFrom('ai_settings')
				.select('value')
				.where('key', '=', 'privacy')
				.executeTakeFirst();
			if (privacy) {
				let stored: unknown;
				try {
					stored = JSON.parse(privacy.value);
				} catch {
					stored = null;
				}
				if (stored && typeof stored === 'object' && 'zeroRetention' in stored) return;
				const value = JSON.stringify({
					...(stored && typeof stored === 'object' ? stored : {}),
					zeroRetention: true,
				});
				await ai
					.updateTable('ai_settings')
					.set({ value, updated_at: Date.now() })
					.where('key', '=', 'privacy')
					.execute();
				return;
			}
			const inUse =
				(await ai.selectFrom('ai_providers').select('id').limit(1).executeTakeFirst()) ??
				(await ai.selectFrom('ai_settings').select('key').limit(1).executeTakeFirst()) ??
				(await ai.selectFrom('ai_usage').select('id').limit(1).executeTakeFirst());
			if (!inUse) return;
			await ai
				.insertInto('ai_settings')
				.values({
					key: 'privacy',
					value: JSON.stringify({
						sendFiles: true,
						sendPeople: true,
						sendVoice: true,
						zeroRetention: true,
					}),
					updated_at: Date.now(),
				})
				.execute();
		},
	},
};
