import { Bot } from 'grammy';
import { telegramTables } from '../tables.ts';
import { errInfo } from './shared.ts';
import type { TelegramDeps, TelegramHandlers } from './types.ts';

export interface Session {
	bot: Bot;
	token: string;
}

export type TelegramState = ReturnType<typeof createState>;

/** What every part of the service shares: its settings, the bot session, the links and replies. */
export function createState(deps: TelegramDeps) {
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

	return {
		db,
		apiRoot,
		http,
		pollTimeout,
		timing,
		log,
		setHandlers(next: TelegramHandlers) {
			handlers = next;
		},
		currentHandlers: () => handlers,
		need,
		tr,
		settingsRow,
		patchSettings,
		newBot,
		session,
		linkByMember,
		linkByUser,
		statusChanged,
		linkChanged,
		removeLink,
		reply,
	};
}
