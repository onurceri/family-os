import { randomInt } from 'node:crypto';
import type {
	Clock,
	DbExecutor,
	Logger,
	NotificationChannel,
	NotificationMessage,
} from '@famos/sdk';
import { FamosError } from '@famos/sdk';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { CallbackQuery, InlineKeyboardButton, Message, Update } from 'grammy/types';
import type { SecretBox } from '../secrets/index.ts';
import type { LinkCode, MemberLink, TelegramStatus } from './schemas.ts';
import { telegramTables } from './tables.ts';

/** What a linked member sent to the bot. */
export interface TelegramShare {
	memberId: string;
	text?: string;
	url?: string;
	files: { name: string; type: string; bytes: Uint8Array }[];
}

/**
 * What the adapter needs from the application. The adapter never imports core or extensions:
 * the composition root wires these (Inbox route, draft approval, translations).
 */
export interface TelegramHandlers {
	/** Adds something to the Inbox as the member. Throw a `FamosError` to refuse. */
	onShare(share: TelegramShare): Promise<void>;
	/**
	 * A question typed in the chat, for the assistant. `asked`: the answer comes later
	 * through `sendAnswer` (the adapter remembers `replyId`); `busy`: the last answer is still
	 * being written; `unavailable`: this member cannot use the assistant, so the text is shared
	 * to the Inbox instead.
	 */
	onAsk?(ask: {
		memberId: string;
		text: string;
		threadId: string | null;
	}): Promise<
		{ status: 'asked'; threadId: string; replyId: string } | { status: 'busy' | 'unavailable' }
	>;
	/**
	 * Approves or rejects a draft as the member, or turns it into the change it offers instead
	 * (`replace`; it then waits to be approved). Throw a `FamosError` to refuse.
	 */
	onDecision(decision: {
		memberId: string;
		draftId: string;
		verb: 'approve' | 'reject' | 'replace';
	}): Promise<void>;
	/**
	 * Pending drafts a notification's source points at, that this recipient may see (the adapter
	 * shows at most five). `instead`: what is already there (a line of the message) and the words
	 * of the button that changes it instead of adding a second one.
	 */
	draftButtons(memberId: string, source: { kind: string; id: string }): Promise<DraftButton[]>;
	/** Renders a message key in the member's language (the family's language when `null`). */
	translate(
		memberId: string | null,
		key: string,
		params?: Record<string, unknown>,
	): string | Promise<string>;
	/** The member's display name, or null when they are archived or unknown. */
	memberName(memberId: string): Promise<string | null>;
}

/** A pending draft as the chat shows it: approve and reject, and maybe a change instead. */
export interface DraftButton {
	id: string;
	label: string;
	instead?: { there: string; action: string };
}

export interface TelegramDeps {
	db: DbExecutor;
	box: SecretBox;
	clock: Clock;
	logger: Logger;
	/** The instance's address; "Open" buttons point into it. */
	baseURL: string;
	/** The Bot API address. Tests inject a stand-in. */
	apiRoot?: string;
	/** Downloads files; defaults to `fetch`. */
	fetch?: typeof fetch;
	/** Seconds Telegram holds a `getUpdates` request open (default 25). */
	pollTimeoutSeconds?: number;
	/** Waiting times of the poller (tests shorten them). */
	timing?: { conflictMs?: number; idleMs?: number; errorBaseMs?: number; errorMaxMs?: number };
	/** Called after the bot or its reported state changed, so open pages can refresh. */
	onStatusChange?: () => void;
	/** Called after a member's link was made or removed (member id only). */
	onLinkChange?: (memberId: string) => void;
	/** The words a key lists in every installed language (command names come from packs). */
	vocabulary?: (key: string) => readonly string[];
}

export type Telegram = ReturnType<typeof createTelegram>;

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_LENGTH = 8;
/** 32 symbols without 0/O/1/I/L lookalikes: every symbol is equally likely. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** The Bot API lets bots download files up to this size. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Same types as the Inbox accepts (UPLOAD_LIMITS.accept); the server checks again. */
const ACCEPTED_TYPES = ['image/*', 'audio/*', 'application/pdf', 'text/plain'];
const EXTENSION_TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	txt: 'text/plain',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	heic: 'image/heic',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	aac: 'audio/aac',
};
const MAX_DRAFT_BUTTONS = 5;
const CALLBACK_DATA_MAX_BYTES = 64;
const MAX_TEXT_CHARS = 3_500;
/** Wrong codes one Telegram account may try per window before it is ignored. */
const MAX_CODE_GUESSES = 10;
const GUESS_WINDOW_MS = 10 * 60 * 1000;
const BOT_TOKEN = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;
const URL_ONLY = /^https?:\/\/\S+$/i;

const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** An assistant answer (light Markdown) as Telegram HTML: `**bold**` and `` `code` `` survive. */
export const answerHtml = (text: string) =>
	escapeHtml(text)
		.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
		.replace(/`([^`\n]+)`/g, '<code>$1</code>')
		.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
const truncate = (text: string, max: number) =>
	[...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
const accepted = (type: string) =>
	ACCEPTED_TYPES.some((a) => (a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a));

/** What is safe to log about a failure: never the payload (it holds message text) or the URL. */
const errInfo = (error: unknown): { err: string; status?: number } =>
	error instanceof GrammyError
		? { err: 'GrammyError', status: error.error_code }
		: { err: error instanceof Error ? error.name : 'unknown' };

const newCode = () =>
	Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(
		'',
	);

/** A pending wait that ends early when the signal aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done);
	});

/**
 * grammY types its abort signals with the `abort-controller` package's polyfill; the native
 * `AbortSignal` it accepts at runtime (it only calls `addEventListener`) does not match structurally.
 */
type GrammySignal = Parameters<Bot['api']['getMe']>[0];
const grammySignal = (signal: AbortSignal) => signal as unknown as GrammySignal;

interface Session {
	bot: Bot;
	token: string;
}

/**
 * Telegram as a channel: long polling in the worker process, members linked by a
 * one-time code, Inbox sharing and draft approval from the chat, and notifications out.
 *
 * Polling: `getUpdates` is driven by a small loop on grammY's typed `bot.api` instead of
 * `bot.start()`. The loop re-reads the settings every round (so a token saved by the API
 * process is picked up), persists the offset after each processed update (restarts never replay),
 * aborts its in-flight request on `stop()`, and backs off on 409 and network errors.
 *
 * The token and the links are credentials, managed outside actions. Nothing here logs message
 * text, file names or tokens.
 */
export function createTelegram(deps: TelegramDeps) {
	const db = () => telegramTables(deps.db);
	const apiRoot = deps.apiRoot ?? 'https://api.telegram.org';
	const http = deps.fetch ?? fetch;
	const pollTimeout = deps.pollTimeoutSeconds ?? 25;
	const timing = {
		conflictMs: deps.timing?.conflictMs ?? 30_000,
		idleMs: deps.timing?.idleMs ?? 10_000,
		errorBaseMs: deps.timing?.errorBaseMs ?? 2_000,
		errorMaxMs: deps.timing?.errorMaxMs ?? 60_000,
	};
	const log = deps.logger.child({ channel: 'telegram' });
	let handlers: TelegramHandlers | undefined;
	const guesses = new Map<number, { count: number; resetAt: number }>();

	/** `/<name> <text>` with a share command name from the language packs: the text, else null. */
	const shareCommandOf = (text: string): { text: string } | null => {
		const m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
		if (!m?.[1]) return null;
		const names = (deps.vocabulary?.('app:telegram_command_share') ?? ['share']).filter((n) =>
			/^[a-z0-9_]{1,32}$/.test(n),
		);
		if (!names.includes(m[1].toLowerCase())) return null;
		return { text: m[2] ?? '' };
	};
	const need = (): TelegramHandlers => {
		if (!handlers) throw new Error('Telegram handlers are not set');
		return handlers;
	};
	const tr = async (memberId: string | null, key: string, params?: Record<string, unknown>) =>
		need().translate(memberId, key, params);

	/* ───────────── Settings ───────────── */

	const settingsRow = () => db().selectFrom('telegram_settings').selectAll().executeTakeFirst();

	async function patchSettings(
		patch: Partial<{
			bot_token: string | null;
			bot_id: number | null;
			bot_username: string | null;
			update_offset: number;
			status_code: string | null;
			status_at: number | null;
		}>,
	) {
		const now = deps.clock.now();
		await db()
			.insertInto('telegram_settings')
			.values({
				id: 1,
				bot_token: null,
				bot_id: null,
				bot_username: null,
				update_offset: 0,
				status_code: null,
				status_at: null,
				updated_at: now,
			})
			.onConflict((oc) => oc.doNothing())
			.execute();
		await db()
			.updateTable('telegram_settings')
			.set({ ...patch, updated_at: now })
			.where('id', '=', 1)
			.execute();
	}

	const newBot = (token: string) => new Bot(token, { client: { apiRoot } });

	async function session(): Promise<Session | null> {
		const row = await settingsRow();
		if (!row?.bot_token) return null;
		const token = deps.box.open(row.bot_token);
		return token === null ? null : { bot: newBot(token), token };
	}

	/* ───────────── Links ───────────── */

	const linkByMember = (memberId: string) =>
		db()
			.selectFrom('telegram_links')
			.selectAll()
			.where('member_id', '=', memberId)
			.executeTakeFirst();
	const linkByUser = (userId: number) =>
		db()
			.selectFrom('telegram_links')
			.selectAll()
			.where('telegram_user_id', '=', userId)
			.executeTakeFirst();
	const statusChanged = () => {
		try {
			deps.onStatusChange?.();
		} catch (error) {
			log.warn(errInfo(error), 'telegram status listener failed');
		}
	};
	const linkChanged = (memberId: string) => {
		try {
			deps.onLinkChange?.(memberId);
		} catch (error) {
			log.warn(errInfo(error), 'telegram link listener failed');
		}
	};
	const removeLink = async (memberId: string) => {
		await db().deleteFrom('telegram_links').where('member_id', '=', memberId).execute();
		linkChanged(memberId);
	};

	/* ───────────── Replies ───────────── */

	async function reply(
		s: Session,
		chatId: number,
		memberId: string | null,
		key: string,
		params?: Record<string, unknown>,
	) {
		try {
			await s.bot.api.sendMessage(chatId, await tr(memberId, key, params), {
				link_preview_options: { is_disabled: true },
			});
		} catch (error) {
			log.warn({ ...errInfo(error), chatId }, 'telegram reply failed');
		}
	}

	/* ───────────── Incoming ───────────── */

	async function download(s: Session, fileId: string): Promise<Uint8Array> {
		const file = await s.bot.api.getFile(fileId);
		if (!file.file_path) throw new Error('Telegram gave no file path');
		const res = await http(`${apiRoot}/file/bot${s.token}/${file.file_path}`, {
			redirect: 'error',
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) throw new Error(`file download failed (${res.status})`);
		const declared = Number(res.headers.get('content-length') ?? 0);
		if (declared > MAX_FILE_BYTES) throw new FamosError('bad_request', 'File too big');
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.length > MAX_FILE_BYTES) throw new FamosError('bad_request', 'File too big');
		return bytes;
	}

	const shareFailureKey = (error: unknown): string => {
		if (error instanceof FamosError) {
			if (error.code === 'limit_reached') return 'telegram_quota';
			if (error.code === 'feature_off') return 'telegram_inbox_off';
			if (error.code === 'forbidden') return 'telegram_not_allowed';
		}
		return 'telegram_failed';
	};

	function guessAllowed(userId: number): boolean {
		const now = deps.clock.now();
		const entry = guesses.get(userId);
		if (!entry || entry.resetAt <= now) return true;
		return entry.count < MAX_CODE_GUESSES;
	}
	function noteWrongGuess(userId: number) {
		const now = deps.clock.now();
		const entry = guesses.get(userId);
		if (!entry || entry.resetAt <= now)
			guesses.set(userId, { count: 1, resetAt: now + GUESS_WINDOW_MS });
		else entry.count++;
	}

	/** `/start <code>`: turns a one-time code into a link. */
	async function claim(s: Session, msg: Message, userId: number, code: string) {
		const chatId = msg.chat.id;
		if (!guessAllowed(userId)) return; // a stranger guessing codes gets no answers
		const now = deps.clock.now();
		await db().deleteFrom('telegram_link_codes').where('expires_at', '<=', now).execute();
		// Single use: whoever deletes the row owns the code.
		const claimed = await db()
			.deleteFrom('telegram_link_codes')
			.where('code', '=', code.toUpperCase())
			.returning('member_id')
			.executeTakeFirst();
		const name = claimed ? await need().memberName(claimed.member_id) : null;
		if (!claimed || name === null) {
			noteWrongGuess(userId);
			await reply(s, chatId, null, 'telegram_code_wrong');
			return;
		}
		const memberId = claimed.member_id;
		await db()
			.transaction()
			.execute(async (trx) => {
				const t = trx;
				// One account per member and one member per account: a new link replaces the old ones.
				await t.deleteFrom('telegram_links').where('member_id', '=', memberId).execute();
				await t.deleteFrom('telegram_links').where('telegram_user_id', '=', userId).execute();
				await t
					.insertInto('telegram_links')
					.values({
						member_id: memberId,
						telegram_user_id: userId,
						chat_id: chatId,
						username: msg.from?.username ?? null,
						linked_at: now,
					})
					.execute();
			});
		log.info({ memberId }, 'telegram account linked');
		linkChanged(memberId);
		await reply(s, chatId, memberId, 'telegram_linked', { name });
	}

	async function onMessage(s: Session, msg: Message) {
		const from = msg.from;
		if (msg.chat.type !== 'private' || !from || from.is_bot) return;
		const text = msg.text ?? msg.caption ?? '';
		const command = /^\/(\w+)(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(msg.text ?? '');
		const link = await linkByUser(from.id);

		if (command?.[1] === 'start' && command[2]) {
			await claim(s, msg, from.id, command[2]);
			return;
		}
		if (!link) {
			// Strangers get an answer to a bare /start only: it is what the Start button sends.
			if (command?.[1] === 'start') await reply(s, msg.chat.id, null, 'telegram_start_hint');
			return;
		}
		const memberId = link.member_id;
		if ((await need().memberName(memberId)) === null) {
			await removeLink(memberId); // archived: the link goes with the person
			return;
		}
		if (link.chat_id !== msg.chat.id || link.username !== (from.username ?? null)) {
			await db()
				.updateTable('telegram_links')
				.set({ chat_id: msg.chat.id, username: from.username ?? null })
				.where('member_id', '=', memberId)
				.execute();
		}

		if (command?.[1] === 'stop') {
			await removeLink(memberId);
			log.info({ memberId }, 'telegram account unlinked from chat');
			await reply(s, msg.chat.id, memberId, 'telegram_unlinked');
			return;
		}
		if (command?.[1] === 'start' || command?.[1] === 'help') {
			await reply(s, msg.chat.id, memberId, 'telegram_help');
			return;
		}
		// The share command (`/share <text>`; language packs add their own names) sends
		// typed text to the Inbox instead of the assistant.
		const shareCommand = shareCommandOf(msg.text ?? '');
		if (shareCommand && !shareCommand.text.trim()) {
			await reply(s, msg.chat.id, memberId, 'telegram_share_empty');
			return;
		}
		if (command && !shareCommand) return; // other commands: nothing to do
		if (msg.video_note) {
			await reply(s, msg.chat.id, memberId, 'telegram_video_unsupported');
			return;
		}

		// Typed text is a question for the assistant; forwarded messages, attachments and bare
		// links are material for the Inbox.
		const typed =
			!shareCommand && msg.forward_origin === undefined && msg.text !== undefined
				? msg.text.trim()
				: '';
		if (typed && !URL_ONLY.test(typed) && handlers?.onAsk) {
			try {
				const outcome = await handlers.onAsk({
					memberId,
					text: typed,
					threadId: link.thread_id,
				});
				if (outcome.status === 'asked') {
					await db()
						.updateTable('telegram_links')
						.set({ thread_id: outcome.threadId, waiting_reply_id: outcome.replyId })
						.where('member_id', '=', memberId)
						.execute();
					await s.bot.api.sendChatAction(msg.chat.id, 'typing').catch(() => undefined);
					return;
				}
				if (outcome.status === 'busy') {
					await reply(s, msg.chat.id, memberId, 'telegram_busy');
					return;
				}
			} catch (error) {
				log.warn({ ...errInfo(error), memberId }, 'telegram question refused');
				await reply(s, msg.chat.id, memberId, 'telegram_failed');
				return;
			}
		}

		const share: TelegramShare = { memberId, files: [] };
		try {
			if (msg.photo?.length) {
				// Sizes come in ascending order; the last is the largest.
				const largest = msg.photo[msg.photo.length - 1];
				if (largest) {
					if ((largest.file_size ?? 0) > MAX_FILE_BYTES)
						throw new FamosError('bad_request', 'too big');
					share.files.push({
						name: `photo-${msg.message_id}.jpg`,
						type: 'image/jpeg',
						bytes: await download(s, largest.file_id),
					});
				}
			}
			// Voice notes (Opus in Ogg) and audio files: the Inbox turns them into text.
			const sound = msg.voice ?? msg.audio;
			if (sound) {
				if ((sound.file_size ?? 0) > MAX_FILE_BYTES) {
					await reply(s, msg.chat.id, memberId, 'telegram_file_too_big');
					return;
				}
				const audioName = msg.audio?.file_name;
				const ext = audioName?.includes('.')
					? audioName.split('.').pop()?.toLowerCase()
					: undefined;
				const type = (
					sound.mime_type ??
					(ext ? EXTENSION_TYPES[ext] : undefined) ??
					'audio/ogg'
				).toLowerCase();
				if (!accepted(type)) {
					await reply(s, msg.chat.id, memberId, 'telegram_file_type_unsupported');
					return;
				}
				share.files.push({
					name: audioName ?? `voice-${msg.message_id}.${type === 'audio/ogg' ? 'ogg' : 'audio'}`,
					type,
					bytes: await download(s, sound.file_id),
				});
			}
			if (msg.document) {
				const doc = msg.document;
				const name = doc.file_name ?? `file-${msg.message_id}`;
				const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
				const type = (
					doc.mime_type ??
					(ext ? EXTENSION_TYPES[ext] : undefined) ??
					''
				).toLowerCase();
				if (!accepted(type)) {
					await reply(s, msg.chat.id, memberId, 'telegram_file_type_unsupported');
					return;
				}
				if ((doc.file_size ?? 0) > MAX_FILE_BYTES) {
					await reply(s, msg.chat.id, memberId, 'telegram_file_too_big');
					return;
				}
				share.files.push({ name, type, bytes: await download(s, doc.file_id) });
			}
		} catch (error) {
			log.warn({ ...errInfo(error), memberId }, 'telegram file download failed');
			const tooBig = error instanceof FamosError;
			await reply(s, msg.chat.id, memberId, tooBig ? 'telegram_file_too_big' : 'telegram_failed');
			return;
		}

		const body = (shareCommand ? shareCommand.text : text).trim();
		if (body) {
			if (URL_ONLY.test(body)) share.url = body;
			else share.text = body;
		}
		if (share.files.length === 0 && !share.text && !share.url) return; // stickers, polls, …

		try {
			await need().onShare(share);
			await reply(s, msg.chat.id, memberId, 'telegram_added');
		} catch (error) {
			log.warn({ ...errInfo(error), memberId }, 'telegram share refused');
			await reply(s, msg.chat.id, memberId, shareFailureKey(error));
		}
	}

	async function onCallback(s: Session, cb: CallbackQuery) {
		const answer = async (text?: string) => {
			try {
				await s.bot.api.answerCallbackQuery(cb.id, text ? { text: truncate(text, 190) } : {});
			} catch (error) {
				log.warn(errInfo(error), 'telegram callback answer failed');
			}
		};
		const match = /^([arm]):(.+)$/.exec(cb.data ?? '');
		const link = await linkByUser(cb.from.id);
		if (!match || !link) return answer();
		const memberId = link.member_id;
		if ((await need().memberName(memberId)) === null) {
			await removeLink(memberId);
			return answer();
		}
		const draftId = match[2] as string;
		const verb = match[1] === 'a' ? 'approve' : match[1] === 'm' ? 'replace' : 'reject';
		let done = true;
		let resultKey =
			verb === 'approve'
				? 'telegram_approved'
				: verb === 'replace'
					? 'telegram_replaced'
					: 'telegram_rejected';
		try {
			await need().onDecision({ memberId, draftId, verb });
		} catch (error) {
			log.info({ ...errInfo(error), memberId, draftId, verb }, 'telegram decision refused');
			if (error instanceof FamosError && error.code === 'forbidden') {
				resultKey = 'telegram_not_allowed';
				done = false; // the buttons stay: someone else with the right may press them
			} else if (error instanceof FamosError && ['conflict', 'not_found'].includes(error.code)) {
				resultKey = 'telegram_already_decided';
			} else {
				resultKey = 'telegram_failed';
				done = false;
			}
		}
		await answer(await tr(memberId, resultKey));
		// Take this draft's buttons away; the rest of the keyboard stays. A draft that became the
		// change it offered gets that change's own buttons in their place, to approve it or not.
		const message = cb.message && cb.message.date !== 0 ? (cb.message as Message) : undefined;
		if (done && message?.reply_markup) {
			const ours = (row: InlineKeyboardButton[]) =>
				row.some((b) => 'callback_data' in b && b.callback_data?.endsWith(`:${draftId}`));
			const all = message.reply_markup.inline_keyboard;
			const rows = all.filter((row) => !ours(row));
			if (verb === 'replace') {
				const at = Math.max(0, all.findIndex(ours));
				rows.splice(at, 0, ...(await draftRows(memberId, { kind: 'draft', id: draftId })).rows);
			}
			try {
				await s.bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
					reply_markup: { inline_keyboard: rows },
				});
			} catch (error) {
				log.warn(errInfo(error), 'telegram keyboard update failed');
			}
		}
	}

	async function handle(s: Session, update: Update) {
		if (update.message) await onMessage(s, update.message);
		else if (update.callback_query) await onCallback(s, update.callback_query);
	}

	/* ───────────── Polling ───────────── */

	let stopping = false;
	let loop: Promise<void> | undefined;
	/** Aborts whatever the loop is waiting on, so it re-reads the settings. */
	let interrupt: AbortController | undefined;
	let lastState: string | null | undefined;

	async function reportState(code: string) {
		if (lastState === code) return;
		lastState = code;
		await patchSettings({ status_code: code, status_at: deps.clock.now() });
		statusChanged();
	}

	async function run() {
		let bot: Session | undefined;
		let sealedFor: string | undefined;
		let webhookCleared = false;
		let failures = 0;
		while (!stopping) {
			const round = new AbortController();
			interrupt = round;
			try {
				const row = await settingsRow();
				if (!row?.bot_token) {
					bot = undefined;
					sealedFor = undefined;
					await sleep(timing.idleMs, round.signal);
					continue;
				}
				if (row.bot_token !== sealedFor) {
					const token = deps.box.open(row.bot_token);
					if (token === null) {
						await reportState('unreadable');
						await sleep(timing.idleMs, round.signal);
						continue;
					}
					bot = { bot: newBot(token), token };
					sealedFor = row.bot_token;
					webhookCleared = false;
					lastState = undefined;
				}
				if (!bot) continue;
				if (!webhookCleared) {
					// A webhook would stop getUpdates from working.
					await bot.bot.api.deleteWebhook(undefined, grammySignal(round.signal));
					webhookCleared = true;
				}
				const updates = await bot.bot.api.getUpdates(
					{
						offset: row.update_offset,
						timeout: pollTimeout,
						allowed_updates: ['message', 'callback_query'],
					},
					grammySignal(round.signal),
				);
				failures = 0;
				await reportState('ok');
				let offset = row.update_offset;
				for (const update of updates) {
					// Handled before (a restart, or Telegram resending): never twice.
					if (update.update_id >= offset) {
						try {
							await handle(bot, update);
						} catch (error) {
							// A broken update must not block the queue behind it.
							log.error(
								{ ...errInfo(error), updateId: update.update_id },
								'telegram update failed',
							);
						}
					}
					offset = Math.max(offset, update.update_id + 1);
					await db()
						.updateTable('telegram_settings')
						.set({ update_offset: offset })
						.where('id', '=', 1)
						.where('bot_token', '=', row.bot_token)
						.execute();
				}
			} catch (error) {
				// Stopped, or the token changed: not a failure.
				if (stopping || round.signal.aborted) continue;
				if (error instanceof GrammyError && error.error_code === 409) {
					log.warn({}, 'another instance polls with this bot token; waiting');
					await reportState('conflict').catch(() => {});
					await sleep(timing.conflictMs, round.signal);
				} else if (error instanceof GrammyError && error.error_code === 401) {
					log.warn({}, 'telegram does not accept the bot token');
					await reportState('invalid_token').catch(() => {});
					await sleep(timing.errorMaxMs, round.signal);
				} else if (error instanceof GrammyError && error.error_code === 429) {
					const wait = (error.parameters.retry_after ?? 5) * 1000;
					await sleep(wait, round.signal);
				} else {
					failures++;
					log.warn({ ...errInfo(error), failures }, 'telegram polling failed; backing off');
					if (error instanceof HttpError) await reportState('offline').catch(() => {});
					const base = Math.min(timing.errorMaxMs, timing.errorBaseMs * 2 ** (failures - 1));
					await sleep(base / 2 + Math.random() * (base / 2), round.signal);
				}
			}
		}
	}

	const wake = () => interrupt?.abort();

	/* ───────────── Outgoing ───────────── */

	function urlOf(path: string | null): string | null {
		if (!path?.startsWith('/')) return null;
		return `${deps.baseURL.replace(/\/+$/, '')}${path}`;
	}

	/**
	 * The buttons of the drafts a message is about, and the lines it must say for them: a draft
	 * that is something already there says so, so approving it never adds a second one unseen,
	 * and offers the change instead on a row of its own.
	 */
	async function draftRows(
		memberId: string,
		source: NotificationMessage['source'],
	): Promise<{ rows: InlineKeyboardButton[][]; notes: string[] }> {
		if (!source) return { rows: [], notes: [] };
		let drafts: DraftButton[];
		try {
			drafts = await need().draftButtons(memberId, source);
		} catch (error) {
			log.warn(errInfo(error), 'telegram draft buttons unavailable');
			return { rows: [], notes: [] };
		}
		const reject = await tr(memberId, 'telegram_btn_reject');
		const rows: InlineKeyboardButton[][] = [];
		const notes: string[] = [];
		for (const draft of drafts.slice(0, MAX_DRAFT_BUTTONS)) {
			const approveData = `a:${draft.id}`;
			const rejectData = `r:${draft.id}`;
			// Telegram refuses longer callback data; a draft that cannot be addressed gets no buttons.
			if (
				Buffer.byteLength(approveData) > CALLBACK_DATA_MAX_BYTES ||
				Buffer.byteLength(rejectData) > CALLBACK_DATA_MAX_BYTES
			) {
				log.warn({ draftId: draft.id }, 'draft id too long for telegram buttons; skipped');
				continue;
			}
			rows.push([
				{ text: `✓ ${truncate(draft.label, 28)}`, callback_data: approveData },
				{ text: `✗ ${reject}`, callback_data: rejectData },
			]);
			if (draft.instead) {
				notes.push(draft.instead.there);
				rows.push([
					{ text: `↪ ${truncate(draft.instead.action, 60)}`, callback_data: `m:${draft.id}` },
				]);
			}
		}
		return { rows, notes };
	}

	const channel: NotificationChannel = {
		id: 'telegram',
		label: 'app:channel_telegram',
		async isAvailableFor(memberId) {
			const row = await settingsRow();
			return row?.bot_token != null && (await linkByMember(memberId)) !== undefined;
		},
		async send(memberId, message) {
			const s = await session();
			const link = await linkByMember(memberId);
			if (!s || !link) return 'gone';
			if ((await need().memberName(memberId)) === null) {
				await removeLink(memberId);
				return 'gone';
			}
			const openUrl = urlOf(message.url);
			// Telegram rejects URL buttons that are not public https addresses (a LAN or http address).
			const button = openUrl?.startsWith('https://') ? openUrl : null;
			const { rows, notes } = await draftRows(memberId, message.source);
			const open = await tr(memberId, 'telegram_btn_open');

			const attempt = async (withButton: boolean) => {
				const lines = [`<b>${escapeHtml(truncate(message.title, 300))}</b>`];
				if (message.body) lines.push(escapeHtml(truncate(message.body, MAX_TEXT_CHARS)));
				for (const note of notes) lines.push(escapeHtml(truncate(note, 300)));
				if (openUrl && !(withButton && button)) lines.push(escapeHtml(openUrl));
				const keyboard = [...rows];
				if (withButton && button) keyboard.push([{ text: open, url: button }]);
				await s.bot.api.sendMessage(link.chat_id, lines.join('\n'), {
					parse_mode: 'HTML',
					link_preview_options: { is_disabled: true },
					...(keyboard.length > 0 && { reply_markup: { inline_keyboard: keyboard } }),
				});
			};
			try {
				try {
					await attempt(true);
				} catch (error) {
					if (
						error instanceof GrammyError &&
						error.error_code === 400 &&
						/BUTTON_URL_INVALID/i.test(error.description)
					)
						await attempt(false);
					else throw error;
				}
				return 'sent';
			} catch (error) {
				if (error instanceof GrammyError) {
					const gone =
						error.error_code === 403 ||
						(error.error_code === 400 &&
							/chat not found|user is deactivated/i.test(error.description));
					if (gone) {
						await removeLink(memberId);
						log.info({ memberId, status: error.error_code }, 'telegram chat is gone; unlinked');
						return 'gone';
					}
					throw new Error(`Telegram refused the message (${error.error_code})`);
				}
				throw new Error('Telegram could not be reached');
			}
		},
	};

	return {
		channel,
		/** Supplies the application callbacks; call once before `start()`. */
		setHandlers(next: TelegramHandlers) {
			handlers = next;
		},

		async status(): Promise<TelegramStatus> {
			const row = await settingsRow();
			if (!row?.bot_token)
				return { configured: false, botUsername: null, state: 'off', checkedAt: null };
			const state = (row.status_code ?? 'pending') as TelegramStatus['state'];
			return {
				configured: true,
				botUsername: row.bot_username,
				state,
				checkedAt: row.status_at,
			};
		},

		/**
		 * Connects a bot (validated with `getMe`), or disconnects it with `null`. A different bot
		 * starts from scratch: its updates, and the links, which only work with the bot they were
		 * made for.
		 */
		async setToken(token: string | null): Promise<void> {
			if (token === null) {
				await patchSettings({
					bot_token: null,
					bot_id: null,
					bot_username: null,
					update_offset: 0,
					status_code: null,
					status_at: null,
				});
				await db().deleteFrom('telegram_links').execute();
				await db().deleteFrom('telegram_link_codes').execute();
				log.info({}, 'telegram bot disconnected');
				statusChanged();
				wake();
				return;
			}
			if (!BOT_TOKEN.test(token))
				throw new FamosError('bad_request', 'This does not look like a bot token');
			let me: { id: number; username?: string | undefined };
			try {
				me = await newBot(token).api.getMe(grammySignal(AbortSignal.timeout(10_000)));
			} catch (error) {
				if (error instanceof GrammyError && (error.error_code === 401 || error.error_code === 404))
					throw new FamosError('bad_request', 'Telegram does not accept this token');
				log.warn(errInfo(error), 'telegram getMe failed');
				throw new FamosError('unavailable', 'Telegram cannot be reached; try again later');
			}
			const before = await settingsRow();
			const sameBot = before?.bot_id === me.id;
			await patchSettings({
				bot_token: deps.box.seal(token),
				bot_id: me.id,
				bot_username: me.username ?? null,
				...(!sameBot && { update_offset: 0 }),
				status_code: null,
				status_at: null,
			});
			if (!sameBot) {
				await db().deleteFrom('telegram_links').execute();
				await db().deleteFrom('telegram_link_codes').execute();
			}
			log.info({ botId: me.id }, 'telegram bot connected');
			statusChanged();
			wake();
		},

		/** A one-time code (10 minutes) and the `t.me` link that carries it into the chat. */
		async createLinkCode(memberId: string): Promise<LinkCode> {
			const row = await settingsRow();
			if (!row?.bot_token || !row.bot_username)
				throw new FamosError('unavailable', 'Telegram is not set up');
			const now = deps.clock.now();
			await db().deleteFrom('telegram_link_codes').where('expires_at', '<=', now).execute();
			await db().deleteFrom('telegram_link_codes').where('member_id', '=', memberId).execute();
			const code = newCode();
			const expiresAt = now + LINK_CODE_TTL_MS;
			await db()
				.insertInto('telegram_link_codes')
				.values({ code, member_id: memberId, expires_at: expiresAt })
				.execute();
			return { code, url: `https://t.me/${row.bot_username}?start=${code}`, expiresAt };
		},

		/**
		 * Sends an assistant answer to the member's chat, if the chat is waiting for exactly this
		 * reply (a question asked in the app is not echoed here). Drafts the turn made come with
		 * approve and reject buttons. Returns whether it was sent.
		 */
		async sendAnswer(
			memberId: string,
			answer: { replyId: string; text: string; draftIds: readonly string[] },
		): Promise<boolean> {
			const link = await linkByMember(memberId);
			if (!link || link.waiting_reply_id !== answer.replyId) return false;
			await db()
				.updateTable('telegram_links')
				.set({ waiting_reply_id: null })
				.where('member_id', '=', memberId)
				.execute();
			const s = await session();
			if (!s) return false;
			const rows: InlineKeyboardButton[][] = [];
			const notes: string[] = [];
			for (const id of answer.draftIds) {
				const found = await draftRows(memberId, { kind: 'draft', id });
				rows.push(...found.rows);
				notes.push(...found.notes);
			}
			const text = answer.text.trim() || (await tr(memberId, 'telegram_failed'));
			const html = [
				answerHtml(truncate(text, MAX_TEXT_CHARS)),
				...notes.map((note) => escapeHtml(truncate(note, 300))),
			].join('\n\n');
			try {
				await s.bot.api.sendMessage(link.chat_id, html, {
					parse_mode: 'HTML',
					link_preview_options: { is_disabled: true },
					...(rows.length > 0 && {
						reply_markup: { inline_keyboard: rows.slice(0, MAX_DRAFT_BUTTONS * 2) },
					}),
				});
				return true;
			} catch (error) {
				log.warn({ ...errInfo(error), memberId }, 'telegram answer failed');
				return false;
			}
		},

		async unlink(memberId: string): Promise<void> {
			await removeLink(memberId);
			await db().deleteFrom('telegram_link_codes').where('member_id', '=', memberId).execute();
		},

		/** The member's link as the app shows it (no ids). */
		async linkOf(memberId: string): Promise<MemberLink> {
			const row = await settingsRow();
			const link = await linkByMember(memberId);
			return {
				available: row?.bot_token != null,
				botUsername: row?.bot_token ? row.bot_username : null,
				linked: link !== undefined,
				username: link?.username ?? null,
			};
		},

		/** Starts the polling loop (worker role). Safe to call twice. */
		start(): void {
			if (loop) return;
			stopping = false;
			loop = run().catch((error) => {
				log.error(errInfo(error), 'telegram poller crashed');
			});
		},

		/** Stops polling; the request in flight is aborted, so this returns promptly. */
		async stop(): Promise<void> {
			stopping = true;
			wake();
			await loop;
			loop = undefined;
		},
	};
}
