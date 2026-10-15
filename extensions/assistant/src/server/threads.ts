import { type Actor, defineAction, defineRoute, FamosError, type UnitOfWork } from '@famos/sdk';
import { z } from 'zod';
import {
	MessageSchema,
	RenameThreadSchema,
	SendMessageSchema,
	SentMessageSchema,
	ThreadDetailSchema,
	ThreadIdSchema,
	ThreadSchema,
	TURN_JOB,
} from '../contract/index.ts';
import { assistantUse } from './capabilities.ts';
import { toMessage } from './messages.ts';
import { tables } from './store.ts';

/** The assistant is personal: every operation is the signed-in member's own. */
function memberOf(actor: Actor): string {
	if (actor.kind !== 'member') throw new FamosError('forbidden', 'Sign in to use the assistant');
	return actor.memberId;
}

/** The member's own thread; someone else's is "not found", never "forbidden" (no existence leak). */
async function ownThread(uow: Pick<UnitOfWork, 'db'>, id: string, memberId: string) {
	const row = await tables(uow.db)
		.selectFrom('assistant_threads')
		.selectAll()
		.where('id', '=', id)
		.where('member_id', '=', memberId)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Thread not found');
	return row;
}

const titleOf = (text: string) => {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};

export const sendMessage = defineAction({
	id: 'assistant.sendMessage',
	title: 'Ask the assistant',
	description:
		'Stores the message and enqueues the assistant’s turn; the answer arrives over the WebSocket.',
	input: SendMessageSchema,
	output: SentMessageSchema,
	requires: assistantUse.id,
	approval: 'never',
	async run(uow, input) {
		const memberId = memberOf(uow.actor);
		const db = tables(uow.db);
		const now = uow.clock.now();
		let threadId: string;
		if (input.threadId) {
			threadId = (await ownThread(uow, input.threadId, memberId)).id;
			// One question at a time: the answer to the last one is still being written.
			const busy = await db
				.selectFrom('assistant_messages')
				.select('id')
				.where('thread_id', '=', threadId)
				.where('status', 'in', ['pending', 'streaming'])
				.executeTakeFirst();
			if (busy) throw new FamosError('conflict', 'The assistant is still answering');
			await db
				.updateTable('assistant_threads')
				.set({ updated_at: now })
				.where('id', '=', threadId)
				.execute();
		} else {
			threadId = uow.ids.next('asst_thread');
			await db
				.insertInto('assistant_threads')
				.values({
					id: threadId,
					member_id: memberId,
					title: titleOf(input.text),
					summary: null,
					summarized_count: 0,
					handles: null,
					created_at: now,
					updated_at: now,
				})
				.execute();
		}
		const messageId = uow.ids.next('asst_msg');
		const replyId = uow.ids.next('asst_msg');
		await db
			.insertInto('assistant_messages')
			.values([
				{
					id: messageId,
					thread_id: threadId,
					role: 'user',
					content: input.text,
					tool_calls: null,
					suggested: null,
					status: 'done',
					error_code: null,
					created_at: now,
				},
				{
					id: replyId,
					thread_id: threadId,
					role: 'assistant',
					content: '',
					tool_calls: null,
					suggested: null,
					status: 'pending',
					error_code: null,
					// After the question, whatever the clock says.
					created_at: now + 1,
				},
			])
			.execute();
		// The model is never called in a request: the turn is a job.
		await uow.enqueue(TURN_JOB, { threadId, messageId: replyId }, { dedupeKey: `turn:${replyId}` });
		return { threadId, messageId, replyId };
	},
});

export const renameThread = defineAction({
	id: 'assistant.renameThread',
	title: 'Rename an assistant thread',
	input: RenameThreadSchema,
	output: ThreadSchema,
	requires: assistantUse.id,
	approval: 'never',
	async run(uow, { id, title }) {
		const row = await ownThread(uow, id, memberOf(uow.actor));
		await tables(uow.db)
			.updateTable('assistant_threads')
			.set({ title })
			.where('id', '=', id)
			.execute();
		return { id, title, updatedAt: row.updated_at };
	},
});

export const deleteThread = defineAction({
	id: 'assistant.deleteThread',
	title: 'Delete an assistant thread',
	input: z.object({ id: ThreadIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	requires: assistantUse.id,
	approval: 'never',
	async run(uow, { id }) {
		await ownThread(uow, id, memberOf(uow.actor));
		const db = tables(uow.db);
		await db.deleteFrom('assistant_messages').where('thread_id', '=', id).execute();
		await db.deleteFrom('assistant_threads').where('id', '=', id).execute();
		return { ok: true as const };
	},
});

export const listThreads = defineRoute({
	method: 'get',
	path: '/threads',
	operationId: 'assistant.listThreads',
	summary: 'My assistant threads, newest first',
	requires: assistantUse.id,
	response: z.array(ThreadSchema),
	async handle(ctx, { actor }) {
		const memberId = memberOf(actor);
		const rows = await tables(ctx.db)
			.selectFrom('assistant_threads')
			.selectAll()
			.where('member_id', '=', memberId)
			.orderBy('updated_at', 'desc')
			.limit(100)
			.execute();
		return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
	},
});

export const getThread = defineRoute({
	method: 'get',
	path: '/threads/{threadId}',
	operationId: 'assistant.getThread',
	summary: 'One of my threads with its messages',
	requires: assistantUse.id,
	params: z.object({ threadId: ThreadIdSchema }),
	response: ThreadDetailSchema,
	async handle(ctx, { params, actor }) {
		const row = await ownThread(ctx, params.threadId, memberOf(actor));
		const messages = await tables(ctx.db)
			.selectFrom('assistant_messages')
			.selectAll()
			.where('thread_id', '=', row.id)
			.orderBy('created_at')
			.orderBy('id')
			.execute();
		return {
			thread: { id: row.id, title: row.title, updatedAt: row.updated_at },
			messages: messages.map(toMessage).map((m) => MessageSchema.parse(m)),
		};
	},
});
