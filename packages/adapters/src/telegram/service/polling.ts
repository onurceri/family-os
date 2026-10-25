import { GrammyError, HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import { errInfo, grammySignal, sleep } from './shared.ts';
import type { Session, TelegramState } from './state.ts';
import type { TelegramDeps } from './types.ts';

/** The `getUpdates` loop of the worker, and starting and stopping it. */
export function createPolling(
	deps: TelegramDeps,
	state: TelegramState,
	handle: (s: Session, update: Update) => Promise<void>,
) {
	const { db, pollTimeout, timing, log, settingsRow, patchSettings, newBot, statusChanged } = state;

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

	return {
		wake,

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
