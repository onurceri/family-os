import type { Actor, MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
let adult: Awaited<ReturnType<TestKernel['member']>>;
let other: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notesExtension] });
	adult = await k.member('member');
	other = await k.member('member');
});
afterEach(() => k.close());

const assistantFor = (m: { member: { id: string } }, source: 'assistant' | 'mcp' = 'assistant') =>
	({
		kind: 'ai',
		mode: source === 'assistant' ? 'conversation' : 'agent',
		source,
		onBehalfOf: m.member.id as MemberId,
		roleId: 'member',
	}) as Actor;
type Listed = {
	id: string;
	label: string;
	group?: string;
	status: string;
	reason?: string;
	decidedAt?: string;
	decidedBy?: string;
	automatic?: true;
}[];
const mine = async (actor: Actor) => {
	const result = await k.runner.invoke<{ suggestions: Listed }>(
		'core.mySuggestions',
		{ limit: 15 },
		actor,
	);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output.suggestions;
};
const suggest = async (actor: Actor, body: string) => {
	const result = await k.runner.invoke('notes.addNote', { body }, actor);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};

describe('core.mySuggestions', () => {
	it('is a read tool for the assistant and for MCP clients', () => {
		for (const source of ['assistant', 'mcp'] as const) {
			const tools = k.ctx.actions.aiReadTools({ local: false, actor: assistantFor(adult, source) });
			expect(tools.map((tool) => tool.id)).toContain('core.mySuggestions');
		}
	});

	it('follows a suggestion from waiting to approved, rejected and undone', async () => {
		const first = await suggest(assistantFor(adult), 'A');
		const second = await suggest(assistantFor(adult), 'B');
		expect((await mine(adult.actor)).map((s) => s.status)).toEqual(['waiting', 'waiting']);

		await k.runner.approveDraft(first, adult.actor);
		await k.runner.rejectDraft(second, adult.actor);
		const after = await mine(assistantFor(adult));
		const byId = (id: string) => after.find((s) => s.id === id);
		expect(byId(first)).toMatchObject({ status: 'approved' });
		expect(byId(first)?.decidedAt).toBeTypeOf('string');
		// The person turned down what their assistant proposed: a rejection, not a withdrawal.
		expect(byId(second)).toMatchObject({ status: 'rejected' });
		expect(byId(second)?.reason).toBeUndefined();
		expect(byId(first)?.reason).toBeUndefined();
		expect(byId(second)?.label).toContain('B');

		await k.runner.undoDraft(first, adult.actor);
		expect((await mine(adult.actor)).find((s) => s.id === first)?.status).toBe('undone');
	});

	it('labels each suggestion by itself and returns the group summary apart', async () => {
		const result = await k.runner.invoke(
			'notes.addNote',
			{ body: 'Call the vet' },
			assistantFor(adult),
			{
				draft: { sourceKind: 'inbox', sourceId: 'm1', summary: 'Quick add: pet and school notes' },
			},
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		const [listed] = await mine(adult.actor);
		expect(listed?.label).toContain('Call the vet');
		expect(listed?.label).not.toContain('Quick add');
		expect(listed?.group).toBe('Quick add: pet and school notes');
	});

	it('says withdrawn only when a person took back a suggestion they made themselves', async () => {
		const kid = await k.member('supervised');
		const own = await suggest(kid.actor, 'Mine');
		await k.runner.rejectDraft(own, kid.actor);
		expect((await mine(kid.actor)).find((s) => s.id === own)).toMatchObject({
			status: 'rejected',
			reason: 'withdrawn',
		});
	});

	it("lists only the actor's own suggestions", async () => {
		await suggest(assistantFor(adult), 'mine');
		await suggest(assistantFor(other), 'theirs');
		expect((await mine(adult.actor)).map((s) => s.label.includes('mine'))).toEqual([true]);
		expect((await mine(assistantFor(other, 'mcp'))).map((s) => s.label.includes('theirs'))).toEqual(
			[true],
		);
		// An agent with nobody behind it has no suggestions of its own.
		expect(await mine({ kind: 'ai', mode: 'share', source: 'inbox' })).toEqual([]);
	});

	it('lists for an agent only what was suggested in its own conversation, with who decided', async () => {
		const via = (source: 'assistant' | 'mcp', sourceId: string) =>
			({ ...assistantFor(adult, source), sourceId }) as Actor;
		const hermes = via('mcp', 'api_token_hermes');
		const ownKey = await k.runner.invoke('notes.addNote', { body: 'Plasters' }, hermes, {
			draft: { sourceKind: 'mcp', sourceId: 'api_token_hermes' },
		});
		if (ownKey.status !== 'drafted') throw new Error('expected a draft');
		// What happened to Hermes in use: the person's Quick add, another app and an assistant
		// thread had suggestions too, all approved by somebody, and Hermes reported them as its own.
		const shared = await k.runner.invoke(
			'notes.addNote',
			{ body: 'Footbridge entry' },
			assistantFor(adult),
			{
				draft: { sourceKind: 'inbox', sourceId: 'inbox_item_1' },
			},
		);
		if (shared.status !== 'drafted') throw new Error('expected a draft');
		const otherApp = await suggest(via('mcp', 'api_token_other'), 'Batteries');
		const thread = await suggest(via('assistant', 'asst_thread_1'), 'Salad');
		// An agent's suggestion for a person who may decide it is theirs alone to decide.
		for (const id of [ownKey.draftId, shared.draftId, otherApp, thread])
			await k.runner.approveDraft(id, adult.actor);

		const listed = await mine(hermes);
		expect(listed.map((s) => s.id)).toEqual([ownKey.draftId]);
		expect(listed[0]).toMatchObject({ status: 'approved', decidedBy: adult.member.displayName });
		expect(listed[0]?.automatic).toBeUndefined();
		// The assistant sees its own thread; the person, asking directly, sees all of theirs.
		expect((await mine(via('assistant', 'asst_thread_1'))).map((s) => s.id)).toEqual([thread]);
		expect(await mine(via('assistant', 'asst_thread_2'))).toEqual([]);
		expect(await mine(adult.actor)).toHaveLength(4);
	});

	it("says it is the agent's own suggestion from the draft's source when the actor did not record one", async () => {
		const result = await k.runner.invoke(
			'notes.addNote',
			{ body: 'Wood glue' },
			assistantFor(adult, 'mcp'),
			{
				draft: { sourceKind: 'mcp', sourceId: 'api_token_hermes' },
			},
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		const hermes = { ...assistantFor(adult, 'mcp'), sourceId: 'api_token_hermes' } as Actor;
		expect((await mine(hermes)).map((s) => s.id)).toEqual([result.draftId]);
	});

	it('names the person who decided a suggestion they had to approve for someone else', async () => {
		const kid = await k.member('supervised');
		const thread = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			sourceId: 'asst_thread_kid',
			onBehalfOf: kid.member.id as MemberId,
			roleId: 'supervised',
		} as Actor;
		const id = await suggest(thread, 'Swim cap');
		await k.runner.approveDraft(id, adult.actor);
		expect(await mine(thread)).toMatchObject([
			{ id, status: 'approved', decidedBy: adult.member.displayName },
		]);
	});
});
