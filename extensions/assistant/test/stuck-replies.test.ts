import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, ThreadDetail } from '../src/contract/index.ts';
import {
	CHAT_TIMEOUT_MS,
	LEAD_TIMEOUT_MS,
	TURN_MAX_LIFE_MS,
	TURN_TIMEOUT_MS,
	UNDERSTAND_TIMEOUT_MS,
} from '../src/server/budget.ts';
import assistant from '../src/server/index.ts';
import type { AssistantTables } from '../src/server/store.ts';
import { turnJob } from '../src/server/turn.ts';
import { MAX_PARTS } from '../src/server/understand.ts';

let k: TestKernel;
let ayse: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Istanbul', locale: 'en' },
		systemActor('test'),
	);
	ayse = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

const db = () => k.ctx.db.withTables<AssistantTables>();
const thread = (threadId: string): Promise<ThreadDetail> =>
	k.route('assistant.getThread').call({ params: { threadId }, actor: ayse.actor });
const lastReply = async (threadId: string): Promise<Message> =>
	(await thread(threadId)).messages.at(-1) as Message;

describe('a turn that ends without an answer', () => {
	it('ends as failed on its last attempt, and the thread takes a new question', async () => {
		// Not an LlmError: the turn cannot tell what went wrong, only that it did.
		k.llm.respond(new Error('boom'), new Error('boom'));
		const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
			'assistant.sendMessage',
			{ text: 'hello' },
			ayse.actor,
		);
		if (sent.status !== 'applied') throw new Error('expected the message to be stored');
		const { threadId } = sent.output;
		await k.worker.drain();
		expect(await lastReply(threadId)).toMatchObject({ status: 'streaming' });
		k.clock.advance(10_000);
		await k.worker.drain();
		expect(await lastReply(threadId)).toMatchObject({ status: 'failed', errorCode: 'unavailable' });

		const again = await k.runner.invoke(
			'assistant.sendMessage',
			{ text: 'hello again', threadId },
			ayse.actor,
		);
		expect(again.status).toBe('applied');
	});
});

describe('the sweep of replies left open', () => {
	it('finishes a reply open past the longest life of its job, and only that', async () => {
		const now = k.clock.now();
		await db()
			.insertInto('assistant_threads')
			.values({
				id: 'asst_thread_1',
				member_id: ayse.member.id,
				title: 'x',
				summary: null,
				summarized_count: 0,
				handles: null,
				created_at: now,
				updated_at: now,
			})
			.execute();
		const reply = (id: string, status: 'streaming' | 'pending' | 'done', at: number) => ({
			id,
			thread_id: 'asst_thread_1',
			role: 'assistant' as const,
			content: '',
			tool_calls: null,
			suggested: null,
			card: null,
			status,
			error_code: null,
			created_at: at,
		});
		await db()
			.insertInto('assistant_messages')
			.values([
				reply('asst_msg_orphan', 'streaming', now),
				reply('asst_msg_waiting', 'pending', now),
				reply('asst_msg_done', 'done', now),
			])
			.execute();
		k.clock.advance(TURN_MAX_LIFE_MS + 1);
		await db()
			.insertInto('assistant_messages')
			.values(reply('asst_msg_fresh', 'streaming', k.clock.now()))
			.execute();
		await k.worker.drain();

		const status = async (id: string) =>
			await db()
				.selectFrom('assistant_messages')
				.select(['status', 'error_code'])
				.where('id', '=', id)
				.executeTakeFirstOrThrow();
		expect(await status('asst_msg_orphan')).toEqual({
			status: 'failed',
			error_code: 'unavailable',
		});
		expect(await status('asst_msg_waiting')).toEqual({
			status: 'failed',
			error_code: 'unavailable',
		});
		expect((await status('asst_msg_done')).status).toBe('done');
		expect((await status('asst_msg_fresh')).status).toBe('streaming');
	});
});

describe('the time a turn may take', () => {
	it('covers every step of it', () => {
		expect(turnJob.timeoutMs).toBeGreaterThanOrEqual(
			UNDERSTAND_TIMEOUT_MS + MAX_PARTS * LEAD_TIMEOUT_MS + CHAT_TIMEOUT_MS,
		);
		expect(turnJob.timeoutMs).toBe(TURN_TIMEOUT_MS);
	});
});
