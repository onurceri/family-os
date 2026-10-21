import type {
	Clock,
	DbExecutor,
	EmailSender,
	EmailSenderInput,
	EmailSettingsAdmin,
} from '@famos/sdk';
import { emailTables } from './tables.ts';

/** Forgets the mailbox and its password, and the mail seen from it. */
export async function disconnectMailbox(db: DbExecutor): Promise<void> {
	await emailTables(db).deleteFrom('email_settings').where('id', '=', 1).execute();
	await emailTables(db).deleteFrom('email_seen').execute();
}

export async function saveSender(
	db: DbExecutor,
	clock: Clock,
	input: EmailSenderInput,
): Promise<EmailSender> {
	const address = input.address.toLowerCase();
	await emailTables(db)
		.insertInto('email_senders')
		.values({
			address,
			member_id: input.memberId,
			label: input.label ?? null,
			created_at: clock.now(),
		})
		.onConflict((oc) =>
			oc.column('address').doUpdateSet({ member_id: input.memberId, label: input.label ?? null }),
		)
		.execute();
	// Mail that waited for this address gets another look at the next check.
	await emailTables(db).deleteFrom('email_seen').where('outcome', '=', 'unknown_sender').execute();
	return { address, memberId: input.memberId, label: input.label ?? null };
}

export async function deleteSender(db: DbExecutor, address: string): Promise<void> {
	await emailTables(db)
		.deleteFrom('email_senders')
		.where('address', '=', address.toLowerCase())
		.execute();
}

/**
 * The mailbox writes an admin action makes, on the unit of work's own connection. The password
 * is never here: saving the mailbox tests it first, so that stays a route.
 */
export function createEmailSettingsAdmin(deps: { clock: Clock }): EmailSettingsAdmin {
	return {
		in: (db) => ({
			disconnect: () => disconnectMailbox(db),
			addSender: (input) => saveSender(db, deps.clock, input),
			removeSender: (address) => deleteSender(db, address),
		}),
	};
}
