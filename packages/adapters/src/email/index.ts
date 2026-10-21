export { createEmailSettingsAdmin } from './admin.ts';
export { createDirMailbox } from './fake-mailbox.ts';
export { createEmailJobs, POLL_JOB } from './jobs.ts';
export {
	connectImap,
	type MailboxConnect,
	type MailboxCredentials,
	MailboxError,
	type MailboxErrorCode,
	type MailboxSession,
} from './mailbox.ts';
export * from './schemas.ts';
export {
	authenticationFailed,
	createEmail,
	type Email,
	type EmailDeps,
	type EmailHandlers,
	type EmailShare,
} from './service.ts';
export { sniffType } from './sniff.ts';
export { type EmailTables, emailMigrations } from './tables.ts';
export { cleanText, htmlToText, limitText } from './text.ts';
