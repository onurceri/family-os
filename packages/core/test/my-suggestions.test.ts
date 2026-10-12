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
	({ kind: 'ai', source, onBehalfOf: m.member.id as MemberId, roleId: 'member' }) as Actor;
type Listed = {
	id: string;
	label: string;
	group?: string;
	status: string;
	reason?: string;
	decidedAt?: string;
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
		expect(await mine({ kind: 'ai', source: 'inbox' })).toEqual([]);
	});
});
