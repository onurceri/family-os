import type { DbExecutor } from '@famos/sdk';
import { FamosError } from '@famos/sdk';
import { GrammyError } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { deleteLink } from './admin.ts';
import type { LinkCode, MemberLink, TelegramStatus } from './schemas.ts';
import { createIncoming } from './service/incoming.ts';
import { createOutgoing } from './service/outgoing.ts';
import { createPolling } from './service/polling.ts';
import {
	answerHtml,
	BOT_TOKEN,
	errInfo,
	escapeHtml,
	grammySignal,
	LINK_CODE_TTL_MS,
	MAX_DRAFT_BUTTONS,
	MAX_TEXT_CHARS,
	newCode,
	truncate,
} from './service/shared.ts';
import { createState } from './service/state.ts';
import type { TelegramDeps, TelegramHandlers } from './service/types.ts';
import type { TelegramTables } from './tables.ts';

export { answerHtml, LINK_CODE_TTL_MS, MAX_FILE_BYTES } from './service/shared.ts';
export type {
	DraftButton,
	TelegramDeps,
	TelegramHandlers,
	TelegramShare,
} from './service/types.ts';

export type Telegram = ReturnType<typeof createTelegram>;

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
	const state = createState(deps);
	const {
		db,
		log,
		tr,
		settingsRow,
		patchSettings,
		newBot,
		session,
		linkByMember,
		statusChanged,
		linkChanged,
		removeLink,
	} = state;
	const { draftRows, channel } = createOutgoing(deps, state);
	const { handle } = createIncoming(deps, state, draftRows);
	const { wake, start, stop } = createPolling(deps, state, handle);

	return {
		channel,
		/** Supplies the application callbacks; call once before `start()`. */
		setHandlers(next: TelegramHandlers) {
			state.setHandlers(next);
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
			await deleteLink(deps.db, memberId);
			linkChanged(memberId);
		},

		/**
		 * After a restore: removes the links the family had ended since the backup. A link goes
		 * when its member is known to `previous` (the database that was set aside) and that
		 * database has no link of theirs to the same chat; a member it does not know is left as
		 * restored. Returns how many went.
		 */
		async carryUnlinks(previous: DbExecutor): Promise<number> {
			const before = previous.withTables<TelegramTables & { core_members: { id: string } }>();
			let known: Set<string>;
			let linked: Map<string, number>;
			try {
				known = new Set(
					(await before.selectFrom('core_members').select('id').execute()).map((m) => m.id),
				);
				linked = new Map(
					(
						await before
							.selectFrom('telegram_links')
							.select(['member_id', 'telegram_user_id'])
							.execute()
					).map((l) => [l.member_id, l.telegram_user_id]),
				);
			} catch (error) {
				if (/no such (table|column)/i.test(String(error))) return 0;
				throw error;
			}
			let removed = 0;
			for (const link of await db().selectFrom('telegram_links').selectAll().execute()) {
				if (!known.has(link.member_id) || linked.get(link.member_id) === link.telegram_user_id)
					continue;
				await removeLink(link.member_id);
				await db()
					.deleteFrom('telegram_link_codes')
					.where('member_id', '=', link.member_id)
					.execute();
				removed += 1;
			}
			return removed;
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

		start,
		stop,
	};
}
