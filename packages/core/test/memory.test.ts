import {
	type Actor,
	defineAction,
	defineCapability,
	isFamosError,
	type MemberId,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// Member memory: personal drafts, ownership and limits.
const shelfEdit = defineCapability({ id: 'shelf.edit', label: 'shelf:cap_edit', level: 'edit' });
const added: { by: string; name: string }[] = [];
const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfEdit],
	actions: [
		defineAction({
			id: 'shelf.add',
			title: 'Add to the shelf',
			input: z.object({ name: z.string().min(1) }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfEdit.id,
			ai: { description: 'adds a thing' },
			async run(uow, input) {
				added.push({
					by: uow.actor.kind === 'member' ? uow.actor.memberId : uow.actor.kind,
					name: input.name,
				});
				return { ok: true };
			},
		}),
		// (An external action cannot carry AI hints at all, so it can never be proposed.)
		defineAction({
			id: 'shelf.peek',
			title: 'Peek',
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			readOnly: true,
			ai: { description: 'reads' },
			async run() {
				return { ok: true };
			},
		}),
		defineAction({
			id: 'shelf.manual',
			title: 'Manual only',
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			requires: shelfEdit.id,
			async run() {
				return { ok: true };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Who;
let can: Who;
let admin: Who;
beforeEach(async () => {
	added.length = 0;
	k = await createTestKernel({ extensions: [shelf] });
	// The first member to exist is the admin of the household.
	admin = await k.member('admin');
	ayse = await k.member('member');
	can = await k.member('member');
});
afterEach(() => k.close());

const ai = (who: Who): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});
const db = () => k.ctx.db.withTables<CoreTables>();
const drafts = () => db().selectFrom('core_drafts').selectAll().execute();
const run = <O>(id: string, input: unknown, who: Who) => k.runner.invoke<O>(id, input, who.actor);
const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
	return 'ok';
};

describe('memory', () => {
	it('is proposed as a draft only its member can see and decide', async () => {
		const result = await k.runner.invoke(
			'core.addMemory',
			{ text: 'I am vegetarian', source: 'ai' },
			ai(ayse),
			{ draft: { sourceKind: 'assistant', sourceId: 'm1' } },
		);
		expect(result.status).toBe('drafted');
		const draftId = (result as { draftId: string }).draftId;
		expect((await drafts())[0]).toMatchObject({ for_member: ayse.member.id });

		// Listed for Ayşe alone: another member and the admin do not see it, nor count it.
		const list = (who: Who) =>
			k.route('core.listDrafts').call({ actor: who.actor, query: { limit: 50 } });
		expect((await list(ayse)).map((d: { id: string }) => d.id)).toEqual([draftId]);
		expect(await list(can)).toEqual([]);
		expect(await list(admin)).toEqual([]);
		expect(await k.route('core.countWaitingDrafts').call({ actor: admin.actor })).toEqual({
			count: 0,
		});
		// Nobody was told: she is looking at it.
		await k.worker.drain();
		expect(await db().selectFrom('core_notifications').selectAll().execute()).toEqual([]);

		// Admins and others cannot approve, reject or undo it; it does not exist for them.
		expect(await code(k.runner.approveDraft(draftId, admin.actor))).toBe('not_found');
		expect(await code(k.runner.rejectDraft(draftId, can.actor))).toBe('not_found');
		expect(await code(k.runner.undoDraft(draftId, admin.actor))).toBe('not_found');

		const approved = await k.runner.approveDraft(draftId, ayse.actor);
		expect(approved.status).toBe('applied');
		const mine = await k.route('core.listMyMemories').call({ actor: ayse.actor });
		expect(mine).toMatchObject([{ text: 'I am vegetarian', source: 'ai' }]);
		// A replay by someone else still learns nothing.
		expect(await code(k.runner.approveDraft(draftId, admin.actor))).toBe('not_found');
	});

	it('can be taken back with Undo', async () => {
		const result = await k.runner.invoke('core.addMemory', { text: 'Call me Ali' }, ai(ayse));
		const draftId = (result as { draftId: string }).draftId;
		await k.runner.approveDraft(draftId, ayse.actor);
		expect(await k.route('core.listMyMemories').call({ actor: ayse.actor })).toHaveLength(1);
		await k.runner.undoDraft(draftId, ayse.actor);
		expect(await k.route('core.listMyMemories').call({ actor: ayse.actor })).toHaveLength(0);
	});

	it('is the member’s own to add, change and delete; nobody reads another’s', async () => {
		const added = await run<{ id: string }>('core.addMemory', { text: 'Likes tea' }, ayse);
		const id = (added as { output: { id: string } }).output.id;

		// Neither another member nor an admin can read, change or delete it.
		expect(await k.route('core.listMyMemories').call({ actor: can.actor })).toEqual([]);
		expect(await k.route('core.listMyMemories').call({ actor: admin.actor })).toEqual([]);
		expect(await code(run('core.updateMemory', { id, text: 'x' }, admin))).toBe('not_found');
		expect(await code(run('core.deleteMemory', { id }, can))).toBe('not_found');
		// The read action used for prompts returns only the caller's own notes.
		const recalled = await run<{ text: string }[]>('core.recallMemories', {}, admin);
		expect((recalled as { output: unknown[] }).output).toEqual([]);
		// The assistant of another member reads that member's notes, never Ayşe's.
		const forCan = await k.runner.invoke<unknown[]>('core.recallMemories', {}, ai(can));
		expect((forCan as { output: unknown[] }).output).toEqual([]);
		const forAyse = await k.runner.invoke<{ text: string }[]>('core.recallMemories', {}, ai(ayse));
		expect((forAyse as { output: { text: string }[] }).output.map((m) => m.text)).toEqual([
			'Likes tea',
		]);
		// The Inbox pipeline (an AI for nobody) reads none.
		expect(
			await code(
				k.runner.invoke('core.recallMemories', {}, { kind: 'ai', mode: 'share', source: 'inbox' }),
			),
		).toBe('forbidden');
		// An outside agent working for Ayşe reads none either: the mode decides, not the source.
		const agent: Actor = { ...ai(ayse), mode: 'agent' } as Actor;
		expect(await code(k.runner.invoke('core.recallMemories', {}, agent))).toBe('forbidden');

		await run('core.updateMemory', { id, text: 'Likes green tea' }, ayse);
		expect(await k.route('core.listMyMemories').call({ actor: ayse.actor })).toMatchObject([
			{ text: 'Likes green tea' },
		]);
		await run('core.deleteMemory', { id }, ayse);
		expect(await k.route('core.listMyMemories').call({ actor: ayse.actor })).toEqual([]);
	});

	it('keeps notes short and few', async () => {
		expect(await code(run('core.addMemory', { text: 'x'.repeat(281) }, ayse))).toBe('bad_request');
		for (let i = 0; i < 100; i++) await run('core.addMemory', { text: `note ${i}` }, ayse);
		expect(await code(run('core.addMemory', { text: 'one more' }, ayse))).toBe('conflict');
	});

	it('is offered to the assistant only, as a tool for the member it works for', () => {
		const names = (actor?: Actor) =>
			k.ctx.actions.aiCatalog(actor ? { actor } : {}).map((a) => a.id);
		expect(names(ai(ayse))).toContain('core.addMemory');
		// Not for the Inbox pipeline, which reads shared content.
		expect(names()).not.toContain('core.addMemory');
		expect(names({ kind: 'ai', mode: 'share', source: 'inbox' })).not.toContain('core.addMemory');
		// The note reader is never a tool.
		expect(k.ctx.actions.aiReadTools({ actor: ai(ayse) }).map((a) => a.id)).not.toContain(
			'core.recallMemories',
		);
	});
});
