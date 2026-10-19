import calendar from '@famos/ext-calendar/server';
import kitchen from '@famos/ext-kitchen/server';
import lists from '@famos/ext-lists/server';
import { LlmError, systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../src/contract/index.ts';
import assistant from '../src/server/index.ts';
import { MAX_PARTS, ReadingSchema } from '../src/server/understand.ts';

// Sunday 18 October 2026 in Ljubljana.
const TZ = 'Europe/Ljubljana';
type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let mara: Asker;

const THURSDAY = {
	quote: 'Do I have anything on Thursday?',
	intent: 'ask',
	topics: ['calendar'],
	span: { said: 'on Thursday', kind: 'day', day: { text: 'Thursday', weekday: 4 } },
	people: [{ said: 'I' }],
};
const SATURDAY = {
	quote: 'what is on Saturday?',
	intent: 'ask',
	topics: ['calendar'],
	span: { said: 'on Saturday', kind: 'day', day: { text: 'Saturday', weekday: 6 } },
	people: [],
};
const KIT = {
	quote: 'I also want to remember to pack my football kit',
	intent: 'change',
	topics: ['tasks'],
	people: [{ said: 'I' }],
};
const MILK = { quote: 'Add milk', intent: 'change', topics: ['shopping'], people: [] };
const DINNER = {
	quote: 'what is for dinner tonight?',
	intent: 'ask',
	topics: ['meals'],
	span: { said: 'tonight', kind: 'day', day: { text: 'tonight', inDays: 0 } },
	people: [],
};

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, kitchen, assistant],
		translate: repoTranslate(),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'en', formatLocale: 'sl-SI', weekStart: 1, hourCycle: 'h23' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-18', '10:00', TZ));
	mara = await k.member('admin', 'Mara');
	const event = (input: Record<string, unknown>) =>
		k.runner.invoke('calendar.createEvent', input, systemActor('test'));
	await event({ title: 'Swimming lesson', date: '2026-10-22', startTime: '16:30' });
	await event({ title: 'U13 match', date: '2026-10-24', startTime: '10:00' });
});
afterEach(() => k.close());

async function ask(text: string) {
	const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text },
		mara.actor,
	);
	if (sent.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	const detail = (await k
		.route('assistant.getThread')
		.call({ params: { threadId: sent.output.threadId }, actor: mara.actor })) as {
		messages: Message[];
	};
	const reply = detail.messages.find((m) => m.id === sent.output.replyId);
	if (!reply) throw new Error('expected the answer');
	return { reply, replyId: sent.output.replyId };
}

describe('the reading of a message with several parts', () => {
	it('reads the old answer, one object, as one part', () => {
		expect(
			ReadingSchema.parse({ intent: 'ask', topics: ['calendar'], people: [] }).parts,
		).toHaveLength(1);
		expect(ReadingSchema.parse({ parts: [THURSDAY, KIT] }).parts.map((p) => p.intent)).toEqual([
			'ask',
			'change',
		]);
	});

	it('drops a part it cannot read, keeps at most four, and falls back to "other"', () => {
		expect(ReadingSchema.parse({ parts: [3, null, KIT] }).parts).toHaveLength(1);
		expect(ReadingSchema.parse({ parts: Array(9).fill(KIT) }).parts).toHaveLength(MAX_PARTS);
		expect(ReadingSchema.parse({ parts: [] }).parts.map((p) => p.intent)).toEqual(['other']);
		expect(ReadingSchema.parse(null).parts.map((p) => p.intent)).toEqual(['other']);
		expect(ReadingSchema.parse('what is on?').parts.map((p) => p.intent)).toEqual(['other']);
	});
});

describe('a question and a request in one message', () => {
	it('answers the question with a card and suggests the request, in one reply (real message of a child)', async () => {
		k.llm.respond({ parts: [THURSDAY, KIT] });
		// The wording of the card, then the tool loop for the request.
		k.llm.respondChat(
			[{ text: 'You have a swimming lesson on Thursday.' }],
			[
				{ tool: 'lists_addTask', input: { title: 'Pack my football kit' } },
				{ text: 'I suggested a task to pack your football kit.' },
			],
		);
		const { reply } = await ask(
			'Do I have anything on Thursday? I also want to remember to pack my football kit',
		);
		expect(reply.status).toBe('done');
		expect(reply.cards).toHaveLength(1);
		expect(reply.card).toEqual(reply.cards[0]);
		expect(reply.cards[0]?.understood.span.from).toBe('2026-10-22');
		expect(reply.cards[0]?.sections[0]?.items.map((i) => i.title)).toEqual(['Swimming lesson']);
		expect(reply.content).toBe(
			'You have a swimming lesson on Thursday.\n\nI suggested a task to pack your football kit.',
		);
		expect(reply.suggested).toHaveLength(1);
		expect(reply.suggested[0]).toContain('Pack my football kit');
		// The loop is for the request only: told what the card answered, with the tools of its topic.
		const [wording, loop] = k.llm.chatCalls;
		expect(wording?.tools).toEqual([]);
		expect(String(wording?.messages[0]?.content)).not.toContain('kit');
		expect(loop?.system).toContain('"Do I have anything on Thursday?"');
		expect(loop?.system).toContain('"I also want to remember to pack my football kit"');
		const names = loop?.tools.map((t) => t.name) ?? [];
		expect(names).toContain('lists_addTask');
		expect(names).not.toContain('kitchen_mealPlan');
	});

	it('does the same with the request first', async () => {
		k.llm.respond({ parts: [MILK, DINNER] });
		k.llm.respondChat(
			[{ text: 'Nothing is planned for dinner tonight.' }],
			[
				{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
				{ text: 'I suggested adding milk.' },
			],
		);
		const { reply } = await ask('Add milk and what is for dinner tonight?');
		expect(reply.status).toBe('done');
		expect(reply.cards.map((c) => c.sections.map((s) => s.topic))).toEqual([['meals', 'calendar']]);
		expect(reply.content).toBe(
			'Nothing is planned for dinner tonight.\n\nI suggested adding milk.',
		);
		expect(reply.suggested).toHaveLength(1);
	});

	it('gives a card to each question, in the order asked, and never calls the loop', async () => {
		k.llm.respond({ parts: [THURSDAY, SATURDAY] });
		k.llm.respondChat(
			[{ text: 'Thursday has a swimming lesson.' }],
			[{ text: 'Saturday has a match.' }],
		);
		const { reply } = await ask('Do I have anything on Thursday? And what is on Saturday?');
		expect(reply.cards.map((c) => c.understood.span.from)).toEqual(['2026-10-22', '2026-10-24']);
		expect(reply.cards.map((c) => c.sections[0]?.items.map((i) => i.title))).toEqual([
			['Swimming lesson'],
			['U13 match'],
		]);
		expect(reply.content).toBe('Thursday has a swimming lesson.\n\nSaturday has a match.');
		expect(k.llm.chatCalls).toHaveLength(2);
		expect(k.llm.chatCalls.every((c) => c.tools.length === 0)).toBe(true);
		// The first card is the card of the old clients.
		expect(reply.card).toEqual(reply.cards[0]);
	});

	it('keeps a plain question and a plain change as they were', async () => {
		k.llm.respond({ parts: [THURSDAY] });
		k.llm.respondChat([{ text: 'A swimming lesson.' }]);
		const question = await ask('Do I have anything on Thursday?');
		expect(question.reply.cards).toHaveLength(1);
		expect(question.reply.content).toBe('A swimming lesson.');
		expect(k.llm.chatCalls[0]?.tools).toEqual([]);

		k.llm.respond({ parts: [MILK] });
		k.llm.respondChat([
			{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
			{ text: 'I suggested adding milk.' },
		]);
		const change = await ask('Add milk');
		expect(change.reply.cards).toEqual([]);
		expect(change.reply.card).toBeNull();
		expect(change.reply.content).toBe('I suggested adding milk.');
		expect(k.llm.chatCalls.at(-1)?.system).not.toContain('more than one part');
	});

	it('keeps the cards when the request cannot be done, and says so', async () => {
		k.llm.respond({ parts: [THURSDAY, KIT] });
		k.llm.respondChat(
			[{ text: 'You have a swimming lesson on Thursday.' }],
			new LlmError('not_configured', 'no'),
		);
		const { reply } = await ask(
			'Do I have anything on Thursday? I also want to remember to pack my football kit',
		);
		expect(reply.status).toBe('done');
		expect(reply.cards).toHaveLength(1);
		expect(reply.content).toBe(
			'You have a swimming lesson on Thursday.\n\nI could not act on the rest of your message. Please ask again.',
		);
	});

	it('gives Telegram the words, the card and the suggestion lines in that order', async () => {
		k.llm.respond({ parts: [THURSDAY, KIT] });
		k.llm.respondChat(
			[{ text: 'You have a swimming lesson on Thursday.' }],
			[
				{ tool: 'lists_addTask', input: { title: 'Pack my football kit' } },
				{ text: 'I suggested a task.' },
			],
		);
		const asked = await k.conversation.ask(mara.member.id, {
			text: 'Do I have anything on Thursday? I also want to remember to pack my football kit',
			threadId: null,
		});
		await k.worker.drain();
		const answer = await k.conversation.answer(mara.member.id, asked.replyId);
		const text = answer?.text ?? '';
		const at = (part: string) => text.indexOf(part);
		expect(at('You have a swimming lesson')).toBe(0);
		expect(at('I suggested a task.')).toBeGreaterThan(at('You have a swimming lesson'));
		expect(at('Swimming lesson')).toBeGreaterThan(at('I suggested a task.'));
		expect(at('Suggested, not added yet')).toBeGreaterThan(at('Swimming lesson'));
	});
});
