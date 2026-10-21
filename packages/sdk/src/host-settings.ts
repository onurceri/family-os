import { z } from 'zod';
import type { DbExecutor } from './ports.ts';

/**
 * What an admin chooses about backups, the family mailbox and Telegram links. The shapes live
 * here because core's actions take them as input and the adapters store them; neither imports
 * the other. Credentials are not among them: a backup target's sealed settings, the passphrase,
 * the mailbox password and the bot token each stay a route.
 */

/** The job that writes a backup now and sends it to the enabled targets. */
export const BACKUP_RUN_JOB = 'backup.run';
/** The job that checks the family mailbox. */
export const EMAIL_POLL_JOB = 'email.poll';

/* ───────────── Backups ───────────── */

/** What the settings page may see of a target's configuration: never a secret. */
export const BackupTargetSummarySchema = z.object({
	endpoint: z.string().optional(),
	region: z.string().optional(),
	bucket: z.string().optional(),
	prefix: z.string().optional(),
	pathStyle: z.boolean().optional(),
	url: z.string().optional(),
	username: z.string().optional(),
});

export const BackupTargetStatusSchema = z.object({
	id: z.string(),
	kind: z.enum(['s3', 'webdav']),
	name: z.string(),
	keep: z.number().int(),
	enabled: z.boolean(),
	lastRunAt: z.number().int().nullable(),
	/** `ok`, or a code such as `http_403`, `unreachable`, `timeout`, `unreadable`. */
	lastResult: z.string().nullable(),
	lastSize: z.number().int().nullable(),
	createdAt: z.number().int(),
	summary: BackupTargetSummarySchema,
});
export type BackupTargetStatus = z.infer<typeof BackupTargetStatusSchema>;

const TargetName = z.string().trim().min(1).max(60);
const TargetKeep = z.number().int().min(1).max(365);

/** Changes to a target that hold no credential: what it is called, how many copies, on or off. */
export const BackupTargetEditSchema = z.object({
	name: TargetName.optional(),
	keep: TargetKeep.optional(),
	enabled: z.boolean().optional(),
});
export type BackupTargetEdit = z.infer<typeof BackupTargetEditSchema>;

export const BackupEncryptionModeSchema = z.enum(['unset', 'passphrase', 'recipient', 'none']);

export const BackupEncryptionStatusSchema = z.object({
	mode: BackupEncryptionModeSchema,
	/** The `age1…` key in recipient mode. */
	recipient: z.string().nullable(),
});
export type BackupEncryptionStatus = z.infer<typeof BackupEncryptionStatusSchema>;

/** The choices that hold no secret: an age public key is not one. A passphrase is set apart. */
export const BackupEncryptionChoiceSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('recipient'), recipient: z.string().trim().min(10).max(200) }),
	z.object({ mode: z.literal('none') }),
]);
export type BackupEncryptionChoice = z.infer<typeof BackupEncryptionChoiceSchema>;

/** The backup settings writes, on the unit of work's own connection (see `AiSettingsAdmin`). */
export interface BackupSettingsWriter {
	/** Replaces the encryption choice; a passphrase stored before is forgotten. */
	setEncryption(choice: BackupEncryptionChoice): Promise<BackupEncryptionStatus>;
	updateTarget(id: string, patch: BackupTargetEdit): Promise<BackupTargetStatus>;
	removeTarget(id: string): Promise<void>;
}

export interface BackupSettingsAdmin {
	/** Whether this is an age public key; the action asks before its transaction opens. */
	isRecipient(recipient: string): Promise<boolean>;
	in(db: DbExecutor): BackupSettingsWriter;
}

/* ───────────── Email ───────────── */

export const EmailSenderSchema = z.object({
	address: z.string(),
	memberId: z.string(),
	label: z.string().nullable(),
});
export type EmailSender = z.infer<typeof EmailSenderSchema>;

export const EmailSenderInputSchema = z.object({
	address: z.string().trim().toLowerCase().max(320).pipe(z.email()),
	memberId: z.string().min(1).max(100),
	label: z.string().trim().max(100).optional(),
});
export type EmailSenderInput = z.infer<typeof EmailSenderInputSchema>;

/** The mailbox writes that need no password (see `AiSettingsAdmin`). */
export interface EmailSettingsWriter {
	/** Forgets the mailbox, its password and the mail seen; the allowed senders stay. */
	disconnect(): Promise<void>;
	addSender(input: EmailSenderInput): Promise<EmailSender>;
	removeSender(address: string): Promise<void>;
}

export interface EmailSettingsAdmin {
	in(db: DbExecutor): EmailSettingsWriter;
}

/* ───────────── Telegram ───────────── */

/** A member's Telegram link (see `AiSettingsAdmin`). */
export interface TelegramLinkWriter {
	/** Removes the member's link and any code that would make one. */
	unlink(memberId: string): Promise<void>;
}

export interface TelegramLinkAdmin {
	in(db: DbExecutor): TelegramLinkWriter;
}
