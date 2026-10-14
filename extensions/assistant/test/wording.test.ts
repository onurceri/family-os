import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../src/contract/index.ts';
import assistant from '../src/server/index.ts';
import { systemPrompt } from '../src/server/prompt.ts';

type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Asker;
let can: Asker;
let deltas: string[];

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists, assistant] });
	await k.runner.invoke('core.updateFamilySettings', { locale: 'en' }, systemActor('test'));
	ayse = await k.member('admin', 'Ayşe');
	can = await k.member('member', 'Can');
	deltas = [];
	k.bus.onMember((memberId, name, payload) => {
		if (memberId === ayse.member.id && name === 'assistant.delta')
			deltas.push((payload as { text: string }).text);
	});
});
afterEach(() => k.close());

/** The thread of the last question, for a follow-up in the same conversation. */
let lastThread = '';

async function ask(who: Asker, text: string, threadId?: string): Promise<Message> {
	const result = await k.runner.invoke<{ threadId: string }>(
		'assistant.sendMessage',
		{ text, ...(threadId && { threadId }) },
		who.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	lastThread = result.output.threadId;
	await k.worker.drain();
	const detail = await k
		.route('assistant.getThread')
		.call({ params: { threadId: result.output.threadId }, actor: who.actor });
	return detail.messages.at(-1) as Message;
}

describe('people in answers', () => {
	it('tells the model to use handles in tool inputs only', () => {
		const prompt = systemPrompt({
			today: '2026-10-08',
			weekday: 'Thursday',
			now: '14:05',
			weekStart: 1,
			timeZone: 'UTC',
			hourCycle: 'h23',
			locale: 'en',
			asker: null,
			members: [{ handle: 'member:1', name: 'Ayşe', about: null }],
			summary: null,
			hasTools: true,
			memories: [],
			records: [],
		});
		expect(prompt).toContain('use a handle like member:1 only in tool inputs');
		expect(prompt).toContain('In your answers never write a handle');
	});

	it('keeps "my" to the asker and other members to a short aside', () => {
		const prompt = systemPrompt({
			today: '2026-10-08',
			weekday: 'Thursday',
			now: '14:05',
			weekStart: 1,
			timeZone: 'UTC',
			hourCycle: 'h23',
			locale: 'en',
			asker: { name: 'Lukas', handle: 'member:1' },
			members: null,
			summary: null,
			hasTools: true,
			memories: [],
			records: [],
		});
		expect(prompt).toContain('mean the person asking (Lukas)');
		expect(prompt).toContain('Also in the family that day');
	});

	it("replaces a handle in the answer with the member's name, stored and streamed", async () => {
		k.llm.respondChat([{ text: 'member:1 has the dentist at 10:30.' }]);
		const answer = await ask(ayse, 'Who has the dentist?');
		expect(answer.content).toBe('Ayşe has the dentist at 10:30.');
		expect(deltas.join('')).toBe('Ayşe has the dentist at 10:30.');
	});

	it('uses a neutral word, never the handle, when names are not shared', async () => {
		k.llm.privacy.sendPeople = false;
		k.llm.respondChat([{ text: 'member:1 has the dentist.' }]);
		const answer = await ask(ayse, 'Who has the dentist?');
		// The test kernel has no catalogs, so the key itself comes back.
		expect(answer.content).toBe('assistant:someone has the dentist.');
		expect(deltas.join('')).toBe('assistant:someone has the dentist.');
	});
});

describe('suggestions', () => {
	it('hands the model a sentence that says it is suggested, not added', async () => {
		k.llm.respondChat([
			{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
			{ text: 'Suggested.' },
		]);
		await ask(can, 'Add milk to the shopping list');
		const result = k.llm.chatTrace[0]?.result ?? '';
		expect(result).toContain('"status":"drafted"');
		expect(result).toContain('Suggested, not added yet:');
		expect(result).toContain('It appears once a person in the household approves it.');
		expect(result).toContain('"suggestion":"draft:1"');
		expect(result).not.toMatch(/draft_[0-9a-f]{8}-/);
	});

	it('lets the model see what happened to its suggestions', async () => {
		k.llm.respondChat(
			[
				{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
				{ text: 'Suggested.' },
			],
			[{ tool: 'core_mySuggestions', input: {} }, { text: 'It is still waiting.' }],
			[{ tool: 'core_mySuggestions', input: {} }, { text: 'Approved.' }],
		);
		await ask(can, 'Add milk to the shopping list');
		const thread = lastThread;
		await ask(can, 'Was it approved?', thread);
		const waiting = k.llm.chatTrace.at(-1)?.result ?? '';
		expect(waiting).toContain('<tool_result name="core.mySuggestions">');
		expect(waiting).toContain('"status":"waiting"');
		expect(waiting).toMatch(/"id":"draft:\d+"/);
		expect(waiting).not.toMatch(/draft_[0-9a-f]{8}-/);

		const drafts = await k.ctx.db
			.withTables<{ core_drafts: { id: string } }>()
			.selectFrom('core_drafts')
			.select('id')
			.execute();
		await k.runner.approveDraft(drafts[0]?.id as string, can.actor);
		await ask(can, 'And now?', thread);
		expect(k.llm.chatTrace.at(-1)?.result).toContain('"status":"approved"');
	});

	it("does not show another member's suggestions", async () => {
		k.llm.respondChat(
			[
				{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
				{ text: 'Suggested.' },
			],
			[{ tool: 'core_mySuggestions', input: {} }, { text: 'Nothing.' }],
		);
		await ask(can, 'Add milk to the shopping list');
		await ask(ayse, 'What is waiting?');
		expect(k.llm.chatTrace.at(-1)?.result).toContain('"suggestions":[]');
	});
});
