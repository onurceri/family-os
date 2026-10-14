import { type ConversationProvider, FamosError, isFamosError } from '@famos/sdk';
import type { z } from 'zod';
import type { SentMessageSchema } from '../contract/index.ts';
import { assistantUse } from './capabilities.ts';
import { tables } from './store.ts';

/**
 * The assistant as the family's conversation for channels outside the app (Telegram): a question
 * goes into the member's own thread like one typed in the app, and the finished answer is read
 * back from it. Only the member who asked can read an answer.
 */
export const conversation: ConversationProvider = {
	requires: assistantUse.id,

	async ask(ctx, actor, { text, threadId }) {
		const send = (thread: string | null) =>
			ctx.actions.invoke<z.infer<typeof SentMessageSchema>>(
				'assistant.sendMessage',
				{ text, ...(thread && { threadId: thread }) },
				actor,
			);
		const result = await send(threadId).catch((error: unknown) => {
			// The thread was deleted in the app: start a new one.
			if (threadId && isFamosError(error) && error.code === 'not_found') return send(null);
			throw error;
		});
		if (result.status !== 'applied')
			throw new FamosError('forbidden', 'The question was not taken');
		return { threadId: result.output.threadId, replyId: result.output.replyId };
	},

	async answer(ctx, memberId, replyId) {
		const row = await tables(ctx.db)
			.selectFrom('assistant_messages')
			.innerJoin('assistant_threads', 'assistant_threads.id', 'assistant_messages.thread_id')
			.select([
				'assistant_messages.content',
				'assistant_messages.status',
				'assistant_messages.error_code',
				'assistant_messages.tool_calls',
			])
			.where('assistant_messages.id', '=', replyId)
			.where('assistant_messages.role', '=', 'assistant')
			.where('assistant_threads.member_id', '=', memberId)
			.executeTakeFirst();
		if (!row || (row.status !== 'done' && row.status !== 'failed')) return null;
		const calls: { draftId?: string }[] = row.tool_calls ? JSON.parse(row.tool_calls) : [];
		return {
			status: row.status === 'done' ? 'done' : row.error_code === 'disabled' ? 'ai_off' : 'failed',
			text: row.status === 'done' ? row.content : '',
			draftIds: calls.flatMap((c) => (c.draftId ? [c.draftId] : [])),
		};
	},
};
