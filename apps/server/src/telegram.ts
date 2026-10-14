import type { Telegram, TelegramHandlers } from '@famos/adapters/telegram';
import { type CoreTables, type Kernel, memberChanged } from '@famos/core';
import { FamosError, subjectOf } from '@famos/sdk';
import { formatClock, formatDate } from '@famos/time';
import { memberActor, shareToInbox } from './inbox-share.ts';

/**
 * Connects the Telegram adapter to the kernel. Everything a chat can do goes through
 * the same doors as the app: the Inbox route for shares, the draft runner for decisions, both
 * as the linked member, so capabilities, quotas and feature switches apply unchanged.
 */
/** The columns of the assistant's messages the chat answer needs (the assistant owns the table). */
type AssistantMessages = {
	assistant_messages: {
		id: string;
		content: string;
		status: string;
		error_code: string | null;
		tool_calls: string | null;
	};
};

export function wireTelegram(telegram: Telegram, kernel: Kernel): void {
	const translate = kernel.translate;
	const core = () => kernel.ctx.db.withTables<CoreTables>();

	const handlers: TelegramHandlers = {
		async memberName(memberId) {
			const row = await core()
				.selectFrom('core_members')
				.select('display_name')
				.where('id', '=', memberId)
				.where('archived_at', 'is', null)
				.executeTakeFirst();
			return row?.display_name ?? null;
		},

		async translate(memberId, key, params) {
			const row = memberId
				? await core()
						.selectFrom('core_members')
						.select('locale')
						.where('id', '=', memberId)
						.executeTakeFirst()
				: undefined;
			const locale = row?.locale ?? (await kernel.ctx.family.settings()).locale;
			return translate(locale, key.includes(':') ? key : `app:${key}`, params);
		},

		async onShare({ memberId, text, url, files }) {
			await shareToInbox(kernel, {
				memberId,
				channel: 'telegram',
				...(text !== undefined && { text }),
				...(url !== undefined && { url }),
				files,
			});
		},

		// A question typed in the chat goes to the assistant as the member.
		async onAsk({ memberId, text, threadId }) {
			const actor = await memberActor(kernel, memberId);
			if (!actor || !kernel.ctx.access.can(actor, 'assistant.use'))
				return { status: 'unavailable' };
			const ask = (thread: string | null) =>
				kernel.runner.invoke<{ threadId: string; replyId: string }>(
					'assistant.sendMessage',
					{ text, ...(thread && { threadId: thread }) },
					actor,
				);
			try {
				const result = await ask(threadId).catch(async (error: unknown) => {
					// The thread was deleted in the app: start a new one.
					if (threadId && error instanceof FamosError && error.code === 'not_found')
						return ask(null);
					throw error;
				});
				if (result.status !== 'applied') return { status: 'unavailable' };
				return {
					status: 'asked',
					threadId: result.output.threadId,
					replyId: result.output.replyId,
				};
			} catch (error) {
				if (error instanceof FamosError) {
					if (error.code === 'conflict') return { status: 'busy' };
					if (['forbidden', 'feature_off', 'not_found'].includes(error.code))
						return { status: 'unavailable' };
				}
				throw error;
			}
		},

		async onDecision({ memberId, draftId, verb }) {
			const actor = await memberActor(kernel, memberId);
			if (!actor) throw new FamosError('forbidden', 'Not a member');
			if (verb === 'approve') await kernel.runner.approveDraft(draftId, actor);
			else if (verb === 'replace') await kernel.runner.replaceDraft(draftId, actor);
			else await kernel.runner.rejectDraft(draftId, actor);
		},

		async draftButtons(memberId, source) {
			// A notification about a single draft points at it by id (kind `draft`).
			const base = core().selectFrom('core_drafts').selectAll();
			const rows = await (source.kind === 'draft'
				? base.where('id', '=', source.id)
				: base.where('source_kind', '=', source.kind).where('source_id', '=', source.id)
			)
				.where('status', '=', 'pending')
				// Drafts addressed to someone else are not this recipient's to see.
				.where((eb) => eb.or([eb('for_member', 'is', null), eb('for_member', '=', memberId)]))
				.orderBy('created_at')
				.execute();
			// Only the ones this person may decide: buttons that would be refused are not shown.
			// One about a day that has passed is expired: no buttons for it.
			const actor = await memberActor(kernel, memberId);
			const passed = await kernel.runner.passedCheck();
			const { formatLocale, hourCycle } = await kernel.ctx.family.settings();
			const when = (at: { date: string; time?: string }) => {
				const day = formatDate(at.date, formatLocale, {
					weekday: 'short',
					day: 'numeric',
					month: 'short',
				});
				return at.time ? `${day} ${formatClock(at.time, formatLocale, hourCycle)}` : day;
			};
			const t = (key: string, params?: Record<string, unknown>) =>
				handlers.translate(memberId, key, params);
			const shown = rows
				.filter((r) => actor !== null && !passed(r) && kernel.runner.mayDecide(r, actor))
				.slice(0, 5);
			return Promise.all(
				shown.map(async (r) => {
					const def = kernel.registry.actions.get(r.action_id);
					const named = subjectOf(r.input);
					// A suggestion that became a change says so, with what it changes.
					const label =
						r.replaced !== null && def?.draftTitle
							? `${await t(def.draftTitle)}${named ? `: ${named}` : ''}`
							: (r.summary ?? def?.title ?? r.action_id);
					const offered = await kernel.runner.alternative(r);
					if (!offered) return { id: r.id, label };
					const name = (offered.input as { label?: unknown }).label;
					const what = [typeof name === 'string' ? name : '', offered.at ? when(offered.at) : '']
						.filter(Boolean)
						.join(' · ');
					return {
						id: r.id,
						label,
						instead: {
							there: await t(offered.key ?? 'app:draft_instead_there', { what, name: what }),
							action: offered.to
								? await t('app:telegram_btn_move_instead', { when: when(offered.to) })
								: await t('app:draft_instead'),
						},
					};
				}),
			);
		},
	};
	telegram.setHandlers(handlers);

	// The answer to a question asked in the chat goes back to the chat when it is written; the
	// adapter sends it only when the chat waits for exactly this reply.
	kernel.bus.onMember(async (memberId, name, payload) => {
		if (name !== 'assistant.done') return;
		const { messageId } = payload as { messageId: string };
		const row = await kernel.ctx.db
			.withTables<AssistantMessages>()
			.selectFrom('assistant_messages')
			.select(['content', 'status', 'error_code', 'tool_calls'])
			.where('id', '=', messageId)
			.executeTakeFirst();
		if (!row) return;
		const calls: { draftId?: string }[] = row.tool_calls ? JSON.parse(row.tool_calls) : [];
		const text =
			row.status === 'done'
				? row.content
				: await handlers.translate(
						memberId,
						row.error_code === 'disabled' ? 'telegram_answer_ai_off' : 'telegram_answer_failed',
					);
		await telegram.sendAnswer(memberId, {
			replyId: messageId,
			text,
			draftIds: calls.flatMap((c) => (c.draftId ? [c.draftId] : [])),
		});
	});

	// An archived member's Telegram account is unlinked (the chat is checked on every message too).
	kernel.bus.on(memberChanged, async ({ memberId, endSessions }) => {
		if (endSessions) await telegram.unlink(memberId);
	});
}
