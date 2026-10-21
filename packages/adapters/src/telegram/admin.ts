import type { DbExecutor, TelegramLinkAdmin } from '@famos/sdk';
import { telegramTables } from './tables.ts';

/** Removes a member's link and any code that would make one. */
export async function deleteLink(db: DbExecutor, memberId: string): Promise<void> {
	await telegramTables(db).deleteFrom('telegram_links').where('member_id', '=', memberId).execute();
	await telegramTables(db)
		.deleteFrom('telegram_link_codes')
		.where('member_id', '=', memberId)
		.execute();
}

/** The link writes an admin action makes, on the unit of work's own connection. */
export function createTelegramLinkAdmin(): TelegramLinkAdmin {
	return { in: (db) => ({ unlink: (memberId) => deleteLink(db, memberId) }) };
}
