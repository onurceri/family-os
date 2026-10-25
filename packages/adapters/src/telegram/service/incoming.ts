import { FamosError, isFamosError } from '@famos/sdk';
import type { CallbackQuery, InlineKeyboardButton, Message, Update } from 'grammy/types';
import type { TelegramOutgoing } from './outgoing.ts';
import {
	accepted,
	EXTENSION_TYPES,
	errInfo,
	GUESS_WINDOW_MS,
	MAX_CODE_GUESSES,
	MAX_FILE_BYTES,
	truncate,
	URL_ONLY,
} from './shared.ts';
import type { Session, TelegramState } from './state.ts';
import type { TelegramDeps, TelegramShare } from './types.ts';

/** Updates in: linking by code, shares and questions from the chat, and pressed draft buttons. */
export function createIncoming(
	deps: TelegramDeps,
	state: TelegramState,
	draftRows: TelegramOutgoing['draftRows'],
) {
	const {
		db,
		apiRoot,
		http,
		log,
		currentHandlers,
		need,
		tr,
		linkByUser,
		linkChanged,
		removeLink,
		reply,
	} = state;
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
		if (declared > MAX_FILE_BYTES) {
			await res.body?.cancel().catch(() => undefined);
			throw new FamosError('bad_request', 'File too big');
		}
		// The announced size can be missing or wrong: count what arrives and stop at the cap.
		const reader = res.body?.getReader();
		if (!reader) return new Uint8Array();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_FILE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new FamosError('bad_request', 'File too big');
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	const shareFailureKey = (error: unknown): string => {
		if (isFamosError(error)) {
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
		const family = (await need().familyName?.()) ?? null;
		if (family) await reply(s, chatId, memberId, 'telegram_linked_family', { name, family });
		else await reply(s, chatId, memberId, 'telegram_linked', { name });
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
		const handlers = currentHandlers();
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
			const tooBig = isFamosError(error);
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
			if (isFamosError(error) && error.code === 'forbidden') {
				resultKey = 'telegram_not_allowed';
				done = false; // the buttons stay: someone else with the right may press them
			} else if (isFamosError(error) && ['conflict', 'not_found'].includes(error.code)) {
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

	return { handle };
}
