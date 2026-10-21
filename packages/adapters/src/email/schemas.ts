import { z } from 'zod';

export const EmailStateSchema = z.enum([
	/** Not set up, or switched off. */
	'off',
	/** Saved and enabled; no check has finished yet. */
	'pending',
	'ok',
	/** The server refused the user name or password. */
	'auth_failed',
	/** The server cannot be reached. */
	'unreachable',
	/** The TLS connection or certificate was refused. */
	'tls_failed',
	/** The mailbox to read does not exist. */
	'mailbox_missing',
	/** The processed folder cannot be created or used. */
	'folder_failed',
	/** The password cannot be read (FAMOS_SECRET changed). */
	'unreadable',
	'error',
]);
export type EmailState = z.infer<typeof EmailStateSchema>;

export const EmailSettingsSchema = z.object({
	configured: z.boolean(),
	host: z.string(),
	port: z.number().int(),
	username: z.string(),
	/** Whether a password is stored. The password itself is never returned. */
	hasPassword: z.boolean(),
	mailbox: z.string(),
	processedFolder: z.string(),
	pollMinutes: z.number().int(),
	enabled: z.boolean(),
	state: EmailStateSchema,
	checkedAt: z.number().int().nullable(),
	/** Messages from addresses that are not on the list, waiting in the mailbox. */
	unknownSenders: z.number().int(),
	/** Messages refused (failed SPF/DKIM, too big, unreadable). */
	refused: z.number().int(),
	/** Messages processed in total. */
	processed: z.number().int(),
	/** Messages that failed in the last check and will be tried again. */
	failed: z.number().int(),
});
export type EmailSettings = z.infer<typeof EmailSettingsSchema>;

const hostname = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(/^[A-Za-z0-9.:_-]+$/, 'A host name or address');
const folder = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.refine((v) => ![...v].some((ch) => ch.charCodeAt(0) < 32), 'No control characters');

export const EmailSettingsInputSchema = z.object({
	host: hostname,
	port: z.number().int().min(1).max(65535).default(993),
	username: z.string().trim().min(1).max(320),
	/** Omit to keep the stored password. */
	password: z.string().min(1).max(500).optional(),
	mailbox: folder.default('INBOX'),
	processedFolder: folder.default('FamilyOS'),
	pollMinutes: z.number().int().min(2).max(1440).default(5),
	enabled: z.boolean().default(true),
});
export type EmailSettingsInput = z.infer<typeof EmailSettingsInputSchema>;

export const EmailTestCodeSchema = z.enum([
	'ok',
	'auth_failed',
	'unreachable',
	'tls_failed',
	'mailbox_missing',
	'folder_failed',
	'unreadable',
	'error',
]);
export type EmailTestCode = z.infer<typeof EmailTestCodeSchema>;

export const EmailSaveResultSchema = z.object({
	settings: EmailSettingsSchema,
	test: z.object({ ok: z.boolean(), code: EmailTestCodeSchema }),
});

export {
	type EmailSender,
	type EmailSenderInput,
	EmailSenderInputSchema,
	EmailSenderSchema,
} from '@famos/sdk';
