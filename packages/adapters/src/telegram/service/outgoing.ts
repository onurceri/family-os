import { isSameOriginPath, type NotificationChannel, type NotificationMessage } from '@famos/sdk';
import { GrammyError } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import {
	CALLBACK_DATA_MAX_BYTES,
	errInfo,
	escapeHtml,
	MAX_DRAFT_BUTTONS,
	MAX_TEXT_CHARS,
	truncate,
} from './shared.ts';
import type { TelegramState } from './state.ts';
import type { DraftButton, TelegramDeps } from './types.ts';

export type TelegramOutgoing = ReturnType<typeof createOutgoing>;

/** Notifications out: the message, its "Open" button and the buttons of the drafts it is about. */
export function createOutgoing(deps: TelegramDeps, state: TelegramState) {
	const { log, need, tr, settingsRow, session, linkByMember, removeLink } = state;

	/* ───────────── Outgoing ───────────── */

	function urlOf(path: string | null): string | null {
		if (!path || !isSameOriginPath(path, deps.baseURL)) return null;
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

	return { draftRows, channel };
}
