import type { Clock, DbExecutor, Logger } from '@famos/sdk';
import { FamosError } from '@famos/sdk';
import PostalMime, { type Address, type Email as ParsedEmail } from 'postal-mime';
import type { SecretBox } from '../secrets/index.ts';
import {
	type MailboxConnect,
	MailboxError,
	type MailboxSession,
	mailboxErrorOf,
} from './mailbox.ts';
import type {
	EmailSender,
	EmailSenderInput,
	EmailSettings,
	EmailSettingsInput,
	EmailState,
	EmailTestCode,
} from './schemas.ts';
import { sniffType } from './sniff.ts';
import { emailTables } from './tables.ts';
import { cleanText, htmlToText, limitText } from './text.ts';

/** What an allowed sender mailed in. */
export interface EmailShare {
	memberId: string;
	title?: string;
	text?: string;
	files: { name: string; type: string; bytes: Uint8Array }[];
}

/** What the adapter needs from the application (the composition root wires the Inbox). */
export interface EmailHandlers {
	/** Adds something to the Inbox as the member. Throw a `FamosError` to refuse. */
	onShare(share: EmailShare): Promise<void>;
}

export interface EmailDeps {
	db: DbExecutor;
	box: SecretBox;
	clock: Clock;
	logger: Logger;
	/** How to reach the mailbox; defaults to IMAP via imapflow. Tests inject a stand-in. */
	connect: MailboxConnect;
	/** Queues a poll in the job queue (deduplicated). */
	enqueuePoll(): Promise<void>;
	/** The share target's limits, so attachments are filtered before they are handed over. */
	limits: { maxFiles: number; maxBytes: number; maxTextChars: number; maxTitleChars: number };
	/** Called after the settings or the reported state changed, so open pages can refresh. */
	onStatusChange?: () => void;
	/** How often the scheduler looks whether a check is due (default 30 s). */
	schedulerTickMs?: number;
}

export type Email = ReturnType<typeof createEmail>;

/** More than this per check waits for the next one, so a check ends well before its timeout. */
const MAX_MESSAGES_PER_CHECK = 40;
/** The largest message source read (attachments are base64, so about 4/3 of their size). */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

const ACCEPTED_TYPES = ['image/', 'audio/', 'application/pdf', 'text/plain'];
const accepted = (type: string) => ACCEPTED_TYPES.some((a) => type.startsWith(a));
const EXTENSIONS: Record<string, string> = {
	'application/pdf': 'pdf',
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/heic': 'heic',
	'audio/wav': 'wav',
	'audio/mp4': 'm4a',
	'audio/ogg': 'ogg',
	'audio/flac': 'flac',
	'audio/mpeg': 'mp3',
	'audio/aac': 'aac',
	'text/plain': 'txt',
};

interface PollResult {
	processed: number;
	unknown: number;
	refused: number;
	failed: number;
}

/** The address a message claims to be from, lowercase; null for groups and missing headers. */
function fromAddress(from: Address | undefined): string | null {
	if (!from || from.group || !from.address) return null;
	return from.address.trim().toLowerCase();
}

/**
 * The verdict of the mailbox host. The host puts its own `Authentication-Results` first;
 * headers further down may come from anyone, so only the topmost one counts.
 */
export function authenticationFailed(email: Pick<ParsedEmail, 'headers'>): boolean {
	const header = email.headers.find((h) => h.key === 'authentication-results');
	return header ? /\b(?:spf|dkim)\s*=\s*fail\b/i.test(header.value) : false;
}

/**
 * Email as a channel: a dedicated mailbox, polled by a job, plain text only.
 *
 * The password is a credential managed outside actions. Nothing here logs subjects, bodies,
 * addresses, file names or the password: only counts and codes.
 */
export function createEmail(deps: EmailDeps) {
	const db = () => emailTables(deps.db);
	const log = deps.logger.child({ channel: 'email' });
	let handlers: EmailHandlers | undefined;
	let polling = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const statusChanged = () => {
		try {
			deps.onStatusChange?.();
		} catch {
			log.warn({}, 'email status listener failed');
		}
	};

	/* ───────────── Settings ───────────── */

	const row = () => db().selectFrom('email_settings').selectAll().executeTakeFirst();

	const count = async (outcome: string) => {
		const r = await db()
			.selectFrom('email_seen')
			.select((eb) => eb.fn.countAll<number>().as('n'))
			.where('outcome', '=', outcome)
			.executeTakeFirst();
		return Number(r?.n ?? 0);
	};

	async function settings(): Promise<EmailSettings> {
		const r = await row();
		const [unknownSenders, refused, processed] = await Promise.all([
			count('unknown_sender'),
			count('refused'),
			count('processed'),
		]);
		const code = r?.status_code ?? null;
		const state: EmailState = !r
			? 'off'
			: !r.enabled && (code === null || code === 'ok')
				? 'off'
				: ((code ?? 'pending') as EmailState);
		const failedText = r?.status_text?.startsWith('failed:') ? Number(r.status_text.slice(7)) : 0;
		return {
			configured: r !== undefined,
			host: r?.host ?? '',
			port: r?.port ?? 993,
			username: r?.username ?? '',
			hasPassword: r !== undefined,
			mailbox: r?.mailbox ?? 'INBOX',
			processedFolder: r?.processed_folder ?? 'FamilyOS',
			pollMinutes: r?.poll_minutes ?? 5,
			enabled: r ? r.enabled === 1 : false,
			state,
			checkedAt: r?.last_checked_at ?? null,
			unknownSenders,
			refused,
			processed,
			failed: Number.isFinite(failedText) ? failedText : 0,
		};
	}

	async function setStatus(code: string, text: string | null = null) {
		await db()
			.updateTable('email_settings')
			.set({ status_code: code, status_text: text, last_checked_at: deps.clock.now() })
			.where('id', '=', 1)
			.execute();
		statusChanged();
	}

	/** Connects, opens the mailbox and makes sure the processed folder exists. */
	async function open(
		credentials: { host: string; port: number; username: string; password: string },
		mailbox: string,
		folder: string,
	): Promise<{ session: MailboxSession; uidValidity: number }> {
		const session = await deps.connect(credentials);
		try {
			const { uidValidity } = await session.select(mailbox);
			await session.ensureFolder(folder);
			return { session, uidValidity };
		} catch (error) {
			await session.close().catch(() => {});
			throw error;
		}
	}

	async function testWith(
		credentials: { host: string; port: number; username: string; password: string },
		mailbox: string,
		folder: string,
	): Promise<EmailTestCode> {
		try {
			const { session } = await open(credentials, mailbox, folder);
			await session.close();
			return 'ok';
		} catch (error) {
			const code = mailboxErrorOf(error).code;
			return code === 'too_big' ? 'error' : code;
		}
	}

	/**
	 * Saves the settings and tests them (login, open the mailbox, create the processed folder).
	 * A failed test still saves what was typed, but switches the channel off.
	 */
	async function update(input: EmailSettingsInput) {
		const existing = await row();
		let password: string | null;
		if (input.password !== undefined) password = input.password;
		else if (existing) password = deps.box.open(existing.password);
		else throw new FamosError('bad_request', 'A password is required');
		if (password === null)
			throw new FamosError('bad_request', 'The stored password cannot be read; enter it again');
		const code = await testWith(
			{ host: input.host, port: input.port, username: input.username, password },
			input.mailbox,
			input.processedFolder,
		);
		const now = deps.clock.now();
		const values = {
			host: input.host,
			port: input.port,
			tls_required: 1,
			username: input.username,
			password: input.password !== undefined ? deps.box.seal(password) : (existing?.password ?? ''),
			mailbox: input.mailbox,
			processed_folder: input.processedFolder,
			poll_minutes: input.pollMinutes,
			enabled: input.enabled && code === 'ok' ? 1 : 0,
			status_code: code === 'ok' ? 'ok' : code,
			status_text: null,
			last_checked_at: now,
			updated_at: now,
		};
		await db()
			.insertInto('email_settings')
			.values({ id: 1, ...values })
			.onConflict((oc) => oc.column('id').doUpdateSet(values))
			.execute();
		// Another mailbox has other UIDs; nothing seen before applies.
		if (
			existing &&
			(existing.host !== input.host ||
				existing.username !== input.username ||
				existing.mailbox !== input.mailbox)
		)
			await db().deleteFrom('email_seen').execute();
		statusChanged();
		return { settings: await settings(), test: { ok: code === 'ok', code } };
	}

	async function remove() {
		await db().deleteFrom('email_settings').where('id', '=', 1).execute();
		await db().deleteFrom('email_seen').execute();
		statusChanged();
	}

	/* ───────────── Senders ───────────── */

	const toSender = (r: {
		address: string;
		member_id: string;
		label: string | null;
	}): EmailSender => ({
		address: r.address,
		memberId: r.member_id,
		label: r.label,
	});

	async function senders(): Promise<EmailSender[]> {
		const rows = await db().selectFrom('email_senders').selectAll().orderBy('address').execute();
		return rows.map(toSender);
	}

	async function addSender(input: EmailSenderInput): Promise<EmailSender> {
		const now = deps.clock.now();
		await db()
			.insertInto('email_senders')
			.values({
				address: input.address.toLowerCase(),
				member_id: input.memberId,
				label: input.label ?? null,
				created_at: now,
			})
			.onConflict((oc) =>
				oc.column('address').doUpdateSet({ member_id: input.memberId, label: input.label ?? null }),
			)
			.execute();
		// Mail that waited for this address gets another look at the next check.
		await db().deleteFrom('email_seen').where('outcome', '=', 'unknown_sender').execute();
		statusChanged();
		return {
			address: input.address.toLowerCase(),
			memberId: input.memberId,
			label: input.label ?? null,
		};
	}

	async function removeSender(address: string): Promise<void> {
		await db().deleteFrom('email_senders').where('address', '=', address.toLowerCase()).execute();
		statusChanged();
	}

	/** Removes the senders of a member who has left (their mail would have no one to belong to). */
	async function removeSendersOf(memberId: string): Promise<void> {
		await db().deleteFrom('email_senders').where('member_id', '=', memberId).execute();
	}

	/* ───────────── Polling ───────────── */

	async function record(
		uidValidity: number,
		uid: number,
		messageId: string | null,
		outcome: string,
	) {
		await db()
			.insertInto('email_seen')
			.values({
				uidvalidity: uidValidity,
				uid,
				message_id: messageId,
				outcome,
				processed_at: deps.clock.now(),
			})
			.onConflict((oc) =>
				oc.columns(['uidvalidity', 'uid']).doUpdateSet({ outcome, message_id: messageId }),
			)
			.execute();
	}

	/** The attachments the Inbox takes, by what they are rather than what they claim to be. */
	function pickFiles(email: ParsedEmail): EmailShare['files'] {
		const files: EmailShare['files'] = [];
		let total = 0;
		for (const [i, a] of email.attachments.entries()) {
			if (files.length >= deps.limits.maxFiles) break;
			// Pictures inside the HTML (logos, signatures, tracking pixels) are not documents.
			if (a.related || a.disposition === 'inline') {
				if (a.mimeType.startsWith('image/')) continue;
			}
			if (typeof a.content === 'string') continue;
			const bytes = new Uint8Array(a.content);
			if (bytes.length === 0 || total + bytes.length > deps.limits.maxBytes) continue;
			const type = sniffType(bytes);
			if (!type || !accepted(type)) continue;
			const ext = EXTENSIONS[type] ?? 'bin';
			const given = a.filename?.trim();
			files.push({ name: given || `attachment-${i + 1}.${ext}`, type, bytes });
			total += bytes.length;
		}
		return files;
	}

	async function readMessage(source: Uint8Array): Promise<ParsedEmail | null> {
		try {
			return await PostalMime.parse(source, { attachmentEncoding: 'arraybuffer' });
		} catch {
			return null;
		}
	}

	/** One message. Returns what became of it; throws when it should be tried again later. */
	async function handleMessage(
		session: MailboxSession,
		folder: string,
		uidValidity: number,
		uid: number,
		allowed: Map<string, string>,
	): Promise<'processed' | 'unknown' | 'refused'> {
		let source: Uint8Array;
		try {
			source = await session.fetchSource(uid, MAX_SOURCE_BYTES);
		} catch (error) {
			if (error instanceof MailboxError && error.code === 'too_big') {
				await record(uidValidity, uid, null, 'refused');
				return 'refused';
			}
			throw error;
		}
		const email = await readMessage(source);
		if (!email) {
			await record(uidValidity, uid, null, 'refused');
			return 'refused';
		}
		const messageId = email.messageId?.trim() || null;

		const address = fromAddress(email.from);
		const memberId = address ? allowed.get(address) : undefined;
		if (!memberId) {
			await record(uidValidity, uid, messageId, 'unknown_sender');
			return 'unknown';
		}
		if (authenticationFailed(email)) {
			await record(uidValidity, uid, messageId, 'refused');
			return 'refused';
		}

		// The same message again (a re-delivery, or a UIDVALIDITY change): do not add it twice.
		const duplicate = messageId
			? await db()
					.selectFrom('email_seen')
					.select('uid')
					.where('message_id', '=', messageId)
					.where('outcome', '=', 'processed')
					.executeTakeFirst()
			: undefined;

		if (!duplicate) {
			const plain = cleanText(email.text ?? '');
			const body = plain || (email.html ? htmlToText(email.html) : '');
			const subject = cleanText(email.subject ?? '').replaceAll('\n', ' ');
			const files = pickFiles(email);
			if (!body && !subject && files.length === 0) {
				await record(uidValidity, uid, messageId, 'refused');
				return 'refused';
			}
			await need().onShare({
				memberId,
				...(subject && { title: limitText(subject, deps.limits.maxTitleChars) }),
				...(body && { text: limitText(body, deps.limits.maxTextChars) }),
				files,
			});
		}
		// Recorded before the move: a failed move must not add the message to the Inbox again.
		await record(uidValidity, uid, messageId, 'processed');
		try {
			await session.move(uid, folder);
		} catch {
			log.warn({}, 'email could not be moved to the processed folder');
		}
		return 'processed';
	}

	const need = (): EmailHandlers => {
		if (!handlers) throw new Error('Email handlers are not set');
		return handlers;
	};

	/**
	 * One check of the mailbox: reads the unread messages that were not seen before. A message
	 * that fails (the Inbox is full, a member is gone) is tried again at the next check and never
	 * blocks the others.
	 */
	async function poll(): Promise<PollResult | null> {
		if (polling) return null;
		polling = true;
		const result: PollResult = { processed: 0, unknown: 0, refused: 0, failed: 0 };
		try {
			const r = await row();
			if (!r?.enabled) return null;
			const password = deps.box.open(r.password);
			if (password === null) {
				await setStatus('unreadable');
				return null;
			}
			let opened: Awaited<ReturnType<typeof open>>;
			try {
				opened = await open(
					{ host: r.host, port: r.port, username: r.username, password },
					r.mailbox,
					r.processed_folder,
				);
			} catch (error) {
				const code = mailboxErrorOf(error).code;
				log.warn({ code }, 'email check failed');
				await setStatus(code === 'too_big' ? 'error' : code);
				return null;
			}
			const { session, uidValidity } = opened;
			try {
				const allowed = new Map((await senders()).map((s) => [s.address, s.memberId] as const));
				const seen = new Set(
					(
						await db()
							.selectFrom('email_seen')
							.select('uid')
							.where('uidvalidity', '=', uidValidity)
							.execute()
					).map((s) => s.uid),
				);
				const todo = (await session.unseenUids()).filter((uid) => !seen.has(uid));
				for (const uid of todo.slice(0, MAX_MESSAGES_PER_CHECK)) {
					try {
						const outcome = await handleMessage(
							session,
							r.processed_folder,
							uidValidity,
							uid,
							allowed,
						);
						if (outcome === 'processed') result.processed++;
						else if (outcome === 'unknown') result.unknown++;
						else result.refused++;
					} catch (error) {
						result.failed++;
						log.warn(
							{
								err: error instanceof Error ? error.name : 'unknown',
								code: (error as { code?: string })?.code,
							},
							'email message failed',
						);
					}
				}
				await setStatus('ok', `failed:${result.failed}`);
				log.info({ ...result }, 'email checked');
			} catch (error) {
				const code = mailboxErrorOf(error).code;
				log.warn({ code }, 'email check failed');
				await setStatus(code === 'too_big' ? 'error' : code);
			} finally {
				await session.close().catch(() => {});
			}
			return result;
		} finally {
			polling = false;
		}
	}

	/** Asks the worker to check now. */
	async function checkNow(): Promise<void> {
		await deps.enqueuePoll();
	}

	/**
	 * Queues a check whenever one is due. The check itself is a job, so it runs in the worker
	 * with a timeout and shows up like any other background work.
	 */
	function start(): void {
		if (timer) return;
		const tick = async () => {
			try {
				const r = await row();
				if (!r?.enabled) return;
				const due = (r.last_checked_at ?? 0) + r.poll_minutes * 60_000;
				if (deps.clock.now() >= due) await deps.enqueuePoll();
			} catch (error) {
				log.warn(
					{ err: error instanceof Error ? error.name : 'unknown' },
					'email scheduler failed',
				);
			}
		};
		timer = setInterval(() => void tick(), deps.schedulerTickMs ?? 30_000);
		timer.unref();
		setTimeout(() => void tick(), 2_000).unref();
	}
	function stop(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	return {
		setHandlers(next: EmailHandlers) {
			handlers = next;
		},
		settings,
		update,
		remove,
		senders,
		addSender,
		removeSender,
		removeSendersOf,
		poll,
		checkNow,
		start,
		stop,
	};
}
