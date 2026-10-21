import {
	type Actor,
	BACKUP_RUN_JOB,
	BackupEncryptionChoiceSchema,
	BackupEncryptionStatusSchema,
	type BackupSettingsAdmin,
	BackupTargetEditSchema,
	BackupTargetStatusSchema,
	defineAction,
	EMAIL_POLL_JOB,
	EmailSenderInputSchema,
	EmailSenderSchema,
	type EmailSettingsAdmin,
	FamosError,
	personPresent,
	type TelegramLinkAdmin,
} from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { emailStatusChanged, telegramLinkChanged } from './core-events.ts';

/**
 * What an admin chooses about backups and the family mailbox, and a member's Telegram link:
 * running a backup now, how backups are encrypted (but not a passphrase), a target's name,
 * retention and switch, removing a target, disconnecting the mailbox, who may mail the Inbox,
 * checking now, and unlinking Telegram. The credentials stay routes (a target's sealed settings,
 * the passphrase, the mailbox password, the bot token), because an action's answer is kept for
 * replays. The capabilities are critical, or for a member's own link one that is theirs alone, and
 * none of these has AI hints, so the AI never runs nor proposes one.
 */

const TargetId = z.string().min(1).max(80);
const targetRow = (input: { targetId: string }) => ({
	table: 'backup_targets',
	id: input.targetId,
});

export function createChannelActions(deps: {
	backups: BackupSettingsAdmin;
	email: EmailSettingsAdmin;
	telegram: TelegramLinkAdmin;
}) {
	/** A person acting directly: an app, the AI and the system never manage these. */
	const person = (actor: Actor) => {
		if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
		return actor;
	};

	const runBackup = defineAction({
		id: 'core.runBackup',
		title: 'Back up now: write a backup and send it to the enabled targets',
		input: z.object({}),
		output: z.object({ queued: z.literal(true) }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow) {
			person(uow.actor);
			// Pressing the button twice queues one backup. The writing is a job on the long lane,
			// so no request waits for it.
			await uow.enqueue(BACKUP_RUN_JOB, {}, { dedupeKey: BACKUP_RUN_JOB });
			return { queued: true as const };
		},
	});

	const setBackupEncryption = defineAction({
		id: 'core.setBackupEncryption',
		title:
			'Choose how backups are encrypted before they leave the server (a passphrase is set apart)',
		input: BackupEncryptionChoiceSchema,
		output: BackupEncryptionStatusSchema,
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		target: () => ({ table: 'backup_settings', id: '1' }),
		async prepare(input, actor) {
			person(actor);
			if (input.mode === 'recipient' && !(await deps.backups.isRecipient(input.recipient)))
				throw new FamosError('bad_request', 'This is not an age public key (it starts with age1)');
			return null;
		},
		async run(uow, input) {
			person(uow.actor);
			return deps.backups.in(uow.db).setEncryption(input);
		},
	});

	const updateBackupTarget = defineAction({
		id: 'core.updateBackupTarget',
		title: 'Rename a backup target, change how many copies it keeps, or pause it',
		input: BackupTargetEditSchema.extend({ targetId: TargetId }),
		output: BackupTargetStatusSchema,
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		target: targetRow,
		async run(uow, { targetId, ...patch }) {
			person(uow.actor);
			return deps.backups.in(uow.db).updateTarget(targetId, patch);
		},
	});

	const deleteBackupTarget = defineAction({
		id: 'core.deleteBackupTarget',
		title: 'Remove a backup target (files already uploaded stay where they are)',
		input: z.object({ targetId: TargetId }),
		output: z.object({ targetId: z.string() }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		target: targetRow,
		async run(uow, { targetId }) {
			person(uow.actor);
			await deps.backups.in(uow.db).removeTarget(targetId);
			return { targetId };
		},
	});

	const disconnectEmail = defineAction({
		id: 'core.disconnectEmail',
		title: 'Forget the family mailbox and its password (the allowed senders stay)',
		input: z.object({}),
		output: z.object({}),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		target: () => ({ table: 'email_settings', id: '1' }),
		async run(uow) {
			person(uow.actor);
			await deps.email.in(uow.db).disconnect();
			uow.emit(emailStatusChanged, {});
			return {};
		},
	});

	const addEmailSender = defineAction({
		id: 'core.addEmailSender',
		title: 'Let an address mail the Inbox, as one member (replaces the entry of the same address)',
		input: EmailSenderInputSchema,
		output: EmailSenderSchema,
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		target: (input) => ({ table: 'email_senders', idColumn: 'address', id: input.address }),
		async run(uow, input) {
			person(uow.actor);
			// Mail from this address acts as that member's share, so it must be someone in the family.
			if (!(await uow.family.members()).some((m) => m.id === input.memberId))
				throw new FamosError('bad_request', 'Choose a member of the family');
			const sender = await deps.email.in(uow.db).addSender(input);
			uow.emit(emailStatusChanged, {});
			return sender;
		},
	});

	const removeEmailSender = defineAction({
		id: 'core.removeEmailSender',
		title: 'Stop accepting mail from an address',
		input: z.object({ address: z.string().trim().toLowerCase().min(1).max(320) }),
		output: z.object({ address: z.string() }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		target: (input) => ({ table: 'email_senders', idColumn: 'address', id: input.address }),
		async run(uow, { address }) {
			person(uow.actor);
			await deps.email.in(uow.db).removeSender(address);
			uow.emit(emailStatusChanged, {});
			return { address };
		},
	});

	const checkEmailNow = defineAction({
		id: 'core.checkEmailNow',
		title: 'Check the family mailbox now (the worker does it in the background)',
		input: z.object({}),
		output: z.object({ queued: z.literal(true) }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow) {
			person(uow.actor);
			await uow.enqueue(EMAIL_POLL_JOB, {}, { dedupeKey: EMAIL_POLL_JOB });
			return { queued: true as const };
		},
	});

	const unlinkTelegram = defineAction({
		id: 'core.unlinkTelegram',
		title: 'Unlink my Telegram account',
		input: z.object({}),
		output: z.object({}),
		// Everyone may end the link of their own account; it changes nothing for anyone else.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow) {
			const actor = person(uow.actor);
			await deps.telegram.in(uow.db).unlink(actor.memberId);
			uow.emit(telegramLinkChanged, { memberId: actor.memberId });
			return {};
		},
	});

	return [
		runBackup,
		setBackupEncryption,
		updateBackupTarget,
		deleteBackupTarget,
		disconnectEmail,
		addEmailSender,
		removeEmailSender,
		checkEmailNow,
		unlinkTelegram,
	];
}
