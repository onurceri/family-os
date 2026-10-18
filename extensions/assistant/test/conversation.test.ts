import lists from '@famos/ext-lists/server';
import { isFamosError, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';
import { loopTurns } from './reading.ts';

// The assistant as the conversation the kernel offers channels outside the app (Telegram).
type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Asker;
let can: Asker;
let answered: { memberId: string; replyId: string }[];

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists, assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Istanbul', locale: 'en' },
		systemActor('test'),
	);
	ayse = await k.member('admin', 'Ayşe');
	can = await k.member('member', 'Can');
	answered = [];
	k.bus.onMember((memberId, name, payload) => {
		if (name === 'core.conversation.answered')
			answered.push({ memberId, replyId: (payload as { replyId: string }).replyId });
	});
});
afterEach(() => k.close());

const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
	return 'ok';
};

describe('the conversation for channels', () => {
	it('answers a question in the member’s thread and tells only them, with its suggestions', async () => {
		loopTurns(k.llm, [
			{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
			{ text: 'I suggested adding milk.' },
		]);
		const asked = await k.conversation.ask(can.member.id, {
			text: 'Add milk to the shopping list',
			threadId: null,
		});
		// Nothing is written while the turn waits for the worker.
		expect(await k.conversation.answer(can.member.id, asked.replyId)).toBeNull();
		await k.worker.drain();

		expect(answered).toEqual([{ memberId: can.member.id, replyId: asked.replyId }]);
		const answer = await k.conversation.answer(can.member.id, asked.replyId);
		expect(answer?.status).toBe('done');
		// A chat has no cards: the fixed line for the suggestion comes under the words.
		expect(answer?.text).toMatch(/^I suggested adding milk\.\n\n/);
		expect(answer?.draftIds).toHaveLength(1);
		// Another member cannot read it, even knowing its id.
		expect(await k.conversation.answer(ayse.member.id, asked.replyId)).toBeNull();

		const threads = await k.route('assistant.listThreads').call({ actor: can.actor });
		expect(threads.map((t: { id: string }) => t.id)).toEqual([asked.threadId]);
	});

	it('continues a thread, starts a new one when it was deleted, and waits for the last answer', async () => {
		loopTurns(k.llm, [{ text: 'One' }], [{ text: 'Two' }], [{ text: 'Three' }]);
		const first = await k.conversation.ask(ayse.member.id, { text: 'First?', threadId: null });
		// The last answer is still being written.
		expect(
			await code(k.conversation.ask(ayse.member.id, { text: 'Again?', threadId: first.threadId })),
		).toBe('conflict');
		await k.worker.drain();
		const second = await k.conversation.ask(ayse.member.id, {
			text: 'Second?',
			threadId: first.threadId,
		});
		expect(second.threadId).toBe(first.threadId);
		await k.worker.drain();

		await k.runner.invoke('assistant.deleteThread', { id: first.threadId }, ayse.actor);
		const third = await k.conversation.ask(ayse.member.id, {
			text: 'Third?',
			threadId: first.threadId,
		});
		expect(third.threadId).not.toBe(first.threadId);
		await k.worker.drain();
		expect(await k.conversation.answer(ayse.member.id, third.replyId)).toMatchObject({
			status: 'done',
			text: 'Three',
		});
	});

	it('says when no model may answer', async () => {
		k.llm.privacy.enabled = false;
		const asked = await k.conversation.ask(ayse.member.id, { text: 'Hello?', threadId: null });
		await k.worker.drain();
		expect(await k.conversation.answer(ayse.member.id, asked.replyId)).toEqual({
			status: 'ai_off',
			text: '',
			draftIds: [],
		});
	});

	it('is closed to a member who may not use the assistant', async () => {
		const guest = await k.member('guest', 'Guest');
		expect(
			await code(k.conversation.ask(guest.member.id, { text: 'Hello?', threadId: null })),
		).toBe('forbidden');
	});
});
