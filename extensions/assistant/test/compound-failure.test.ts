import calendar from '@famos/ext-calendar/server';
import kitchen from '@famos/ext-kitchen/server';
import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/contract/index.ts';
import assistant from '../src/server/index.ts';

// A question that cannot be answered (an area failing in a way nothing catches) must not take
// the request down with it: questions about dinner fail here, whatever else is asked.
vi.mock('../src/server/question.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/server/question.ts')>();
	return {
		...original,
		answerQuestion: (...args: Parameters<typeof original.answerQuestion>) => {
			if (args[1].question.topics.includes('meals')) throw new Error('boom');
			return original.answerQuestion(...args);
		},
	};
});

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, kitchen, assistant],
		translate: repoTranslate(),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{
			timeZone: 'Europe/Ljubljana',
			locale: 'en',
			formatLocale: 'sl-SI',
			weekStart: 1,
			hourCycle: 'h23',
		},
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-18', '10:00', 'Europe/Ljubljana'));
});
afterEach(() => k.close());

async function ask(who: Awaited<ReturnType<TestKernel['member']>>, text: string) {
	const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text },
		who.actor,
	);
	if (sent.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	const detail = (await k
		.route('assistant.getThread')
		.call({ params: { threadId: sent.output.threadId }, actor: who.actor })) as {
		messages: Message[];
	};
	const reply = detail.messages.find((m) => m.id === sent.output.replyId);
	if (!reply) throw new Error('expected the answer');
	return reply;
}

describe('a part never takes another down', () => {
	it('still runs the request when the question fails, and says what was missed', async () => {
		const mara = await k.member('admin', 'Mara');
		k.llm.respond({
			parts: [
				{ intent: 'change', topics: ['shopping'], people: [], quote: 'Add milk' },
				{ intent: 'ask', topics: ['meals'], people: [], quote: 'what is for dinner?' },
			],
		});
		k.llm.respondChat([
			{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
			{ text: 'I suggested adding milk.' },
		]);
		const reply = await ask(mara, 'Add milk and what is for dinner?');
		expect(reply.status).toBe('done');
		expect(reply.cards).toEqual([]);
		expect(reply.suggested).toHaveLength(1);
		expect(reply.content).toBe(
			'I suggested adding milk.\n\nI could not look up one of the things you asked about. Please ask again.',
		);
	});

	it('fails as before when the only question fails', async () => {
		const mara = await k.member('admin', 'Mara');
		k.llm.respond({ parts: [{ intent: 'ask', topics: ['meals'], people: [] }] });
		const reply = await ask(mara, 'What is for dinner?');
		expect(reply.status).toBe('failed');
		expect(reply.errorCode).toBe('unavailable');
	});
});
