import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { type Actor, isFamosError, type MemberId } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, ThreadDetail } from '../src/contract/index.ts';
import assistant from '../src/server/index.ts';

// Memory through the assistant.
type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Who;
let can: Who;
let admin: Who;
beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, assistant],
		translate: repoTranslate(),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Istanbul', locale: 'en' },
		{ kind: 'system', source: 'test' },
	);
	// Member handles follow creation order: ayse member:1, can member:2.
	ayse = await k.member('member', 'Ayşe');
	can = await k.member('member', 'Can');
	admin = await k.member('admin', 'Admin');
});
afterEach(() => k.close());

async function ask(who: Who, text: string, extra: Record<string, unknown> = {}) {
	const result = await k.runner.invoke<{ threadId: string; messageId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text, ...extra },
		who.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	return result.output;
}
const thread = (who: Who, threadId: string): Promise<ThreadDetail> =>
	k.route('assistant.getThread').call({ params: { threadId }, actor: who.actor });
const lastReply = async (who: Who, threadId: string): Promise<Message> =>
	(await thread(who, threadId)).messages.findLast((m) => m.role === 'assistant') as Message;
const draftIdOf = async (who: Who, threadId: string, index = 0) =>
	(await lastReply(who, threadId)).toolCalls[index]?.draftId as string;
const systemPrompt = (n = -1) => k.llm.chatCalls.at(n)?.system ?? '';
const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
	return 'ok';
};
const asAi = (who: Who): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});

describe('memory', () => {
	async function remember(text = 'I am vegetarian') {
		k.llm.respondChat([
			{ tool: 'core_addMemory', input: { text } },
			{ text: 'I suggested keeping that; please confirm it.' },
		]);
		const sent = await ask(ayse, `Remember: ${text}`);
		return { sent, draftId: await draftIdOf(ayse, sent.threadId) };
	}

	it('is proposed as a draft that only its member can see and approve', async () => {
		const { sent, draftId } = await remember();
		expect(draftId).toBeTruthy();
		const list = (who: Who) =>
			k.route('core.listDrafts').call({ actor: who.actor, query: { limit: 50 } });
		expect((await list(ayse)).map((d: { id: string }) => d.id)).toEqual([draftId]);
		expect(await list(can)).toEqual([]);
		expect(await list(admin)).toEqual([]);
		expect(await code(k.runner.approveDraft(draftId, admin.actor))).toBe('not_found');
		expect(await k.route('core.listMyMemories').call({ actor: ayse.actor })).toEqual([]);

		await k.runner.approveDraft(draftId, ayse.actor);
		expect(await k.route('core.listMyMemories').call({ actor: ayse.actor })).toMatchObject([
			{ text: 'I am vegetarian', source: 'ai' },
		]);
		expect(sent.threadId).toBeTruthy();
	});

	it('is given to the model in the member’s own threads only', async () => {
		const { draftId } = await remember();
		await k.runner.approveDraft(draftId, ayse.actor);

		k.llm.respondChat([{ text: 'Noted' }]);
		await ask(ayse, 'What should we cook?');
		expect(systemPrompt()).toContain('<memory>');
		expect(systemPrompt()).toContain('I am vegetarian');

		// Another member's thread, and an admin's, never carry it.
		k.llm.respondChat([{ text: 'Pasta' }], [{ text: 'Soup' }]);
		await ask(can, 'What should we cook?');
		expect(JSON.stringify(k.llm.chatCalls.at(-1))).not.toContain('vegetarian');
		await ask(admin, 'What should we cook?');
		expect(JSON.stringify(k.llm.chatCalls.at(-1))).not.toContain('vegetarian');
	});

	it('is withheld while the family does not let people’s details reach the model', async () => {
		const { draftId } = await remember();
		await k.runner.approveDraft(draftId, ayse.actor);
		k.llm.privacy.sendPeople = false;
		k.llm.respondChat([{ text: 'Pasta' }]);
		await ask(ayse, 'What should we cook?');
		expect(systemPrompt()).not.toContain('vegetarian');
	});

	it('is capped by count and characters, newest first', async () => {
		for (let i = 0; i < 30; i++)
			await k.runner.invoke(
				'core.addMemory',
				{ text: `note ${String(i).padStart(2, '0')} ${'x'.repeat(200)}` },
				ayse.actor,
			);
		k.llm.respondChat([{ text: 'ok' }]);
		await ask(ayse, 'hello');
		const prompt = systemPrompt();
		expect(prompt).toContain('note 29');
		expect(prompt).not.toContain('note 00');
		const block = prompt.slice(prompt.indexOf('<memory>'), prompt.indexOf('</memory>'));
		expect(block.length).toBeLessThan(1800);
	});

	it('is never a tool for the Inbox pipeline or MCP, nor readable by them', async () => {
		const inbox: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
		const catalog = k.ctx.actions.aiCatalog({ actor: inbox }).map((a) => a.id);
		expect(catalog).not.toContain('core.addMemory');
		expect(k.ctx.actions.aiCatalog({}).map((a) => a.id)).not.toContain('core.addMemory');
		await k.runner.invoke('core.addMemory', { text: 'secret' }, ayse.actor);
		expect(await code(k.runner.invoke('core.recallMemories', {}, inbox))).toBe('forbidden');
		const mine = await k.runner.invoke<unknown[]>('core.recallMemories', {}, asAi(can));
		expect(mine.status === 'applied' && mine.output).toEqual([]);
	});
});
