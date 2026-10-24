import type { Logger } from '@famos/adapters/runtime';
import { createSecretBox } from '@famos/adapters/secrets';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** Each credential kind has its own derived key, so a value sealed for one never opens as another. */
export const SECRET_PURPOSES = {
	/** The AI provider keys keep the purpose they were first sealed with, so their rows keep opening. */
	ai: 'ai-provider-keys',
	webPush: 'webpush',
	telegram: 'telegram',
} as const;

/** The key Web Push and Telegram values were first sealed with, shared with the AI keys. */
const LEGACY_PURPOSE = SECRET_PURPOSES.ai;

const SEALED = [
	{
		label: 'Web Push key',
		table: 'webpush_keys',
		column: 'private_key',
		purpose: SECRET_PURPOSES.webPush,
	},
	{
		label: 'Telegram token',
		table: 'telegram_settings',
		column: 'bot_token',
		purpose: SECRET_PURPOSES.telegram,
	},
] as const;

/**
 * Seals the Web Push key and the Telegram token with their own keys. A value the new key opens is left alone;
 * one only the old shared key opens is sealed again and written back; anything else is left and warned about
 * (without the value). The old key is used here only, never as a fallback for reading.
 */
export async function resealLegacySecrets(
	db: Kysely<unknown>,
	secret: string,
	logger: Logger,
): Promise<void> {
	const legacy = createSecretBox(secret, LEGACY_PURPOSE);
	for (const { label, table, column, purpose } of SEALED) {
		const current = createSecretBox(secret, purpose);
		const rows = await sql<{ rid: number; sealed: string }>`
			select rowid as rid, ${sql.ref(column)} as sealed from ${sql.table(table)} where ${sql.ref(column)} is not null`.execute(
			db,
		);
		for (const row of rows.rows) {
			if (current.open(row.sealed) !== null) continue;
			const plain = legacy.open(row.sealed);
			if (plain === null) {
				logger.warn(
					{ table },
					`The ${label} cannot be read: FAMOS_SECRET differs from the one it was sealed with`,
				);
				continue;
			}
			const resealed = current.seal(plain);
			await sql`update ${sql.table(table)} set ${sql.ref(column)} = ${resealed} where rowid = ${row.rid} and ${sql.ref(column)} = ${row.sealed}`.execute(
				db,
			);
			logger.info({ table }, `The ${label} is sealed with its own key`);
		}
	}
}
