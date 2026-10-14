import {
	type Actor,
	defineAction,
	defineCapability,
	FamosError,
	isFamosError,
	type MemberId,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// Who may decide, withdraw or count a draft, and what happens to a draft about something gone.
const shelfUse = defineCapability({ id: 'shelf.use', label: 'shelf:cap_use', level: 'use' });
const shelfManage = defineCapability({
	id: 'shelf.manage',
	label: 'shelf:cap_manage',
	level: 'edit',
});
const things = new Set(['lamp']);
const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfUse, shelfManage],
	actions: [
		defineAction({
			id: 'shelf.remove',
			title: 'Remove a thing',
			draftTitle: 'shelf:draft_title_remove',
			input: z.object({ name: z.string().min(1) }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			approval: { unless: shelfManage.id },
			async run(_uow, input) {
				if (!things.delete(input.name)) throw new FamosError('not_found', 'Thing not found');
				return { ok: true };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let admin: Who;
let parent: Who;
let kid: Who;
let sibling: Who;
beforeEach(async () => {
	things.clear();
	things.add('lamp');
	k = await createTestKernel({ extensions: [shelf] });
	admin = await k.member('admin');
	parent = await k.member('member');
	kid = await k.member('supervised');
	sibling = await k.member('supervised');
});
afterEach(() => k.close());

const db = () => k.ctx.db.withTables<import('../src/tables.ts').CoreTables>();
const draftRow = (id: string) =>
	db().selectFrom('core_drafts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
	return 'ok';
};
const propose = async (who: Who, name = 'lamp') => {
	const result = await k.runner.invoke('shelf.remove', { name }, who.actor);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
const waiting = (who: Who) =>
	k.route('core.countWaitingDrafts').call({ actor: who.actor }) as Promise<{ count: number }>;
const aiFor = (who: Who): Actor => ({
	kind: 'ai',
	mode: 'agent',
	source: 'mcp',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});

describe('withdrawing a suggestion', () => {
	it('lets the proposer take their own pending draft back, and no one else without approval', async () => {
		const id = await propose(kid);
		expect(await code(k.runner.rejectDraft(id, sibling.actor))).toBe('forbidden');
		const closed = await k.runner.rejectDraft(id, kid.actor);
		expect(closed).toMatchObject({ status: 'rejected', decided_by: kid.member.id });
		const view = await k.route('core.listDrafts').call({ actor: kid.actor, query: { limit: 10 } });
		expect(view[0]).toMatchObject({ id, status: 'rejected', reason: 'withdrawn' });
		const audit = await db().selectFrom('core_audit_log').selectAll().execute();
		expect(audit.filter((a) => a.draft_id === id).map((a) => a.outcome)).toEqual([
			'drafted',
			'rejected',
		]);
		// It cannot be approved any more.
		expect(await code(k.runner.approveDraft(id, parent.actor))).toBe('conflict');
	});

	it('lets the member behind an AI draft withdraw it', async () => {
		const result = await k.runner.invoke('shelf.remove', { name: 'lamp' }, aiFor(kid));
		const id = (result as { draftId: string }).draftId;
		expect(await code(k.runner.rejectDraft(id, sibling.actor))).toBe('forbidden');
		expect((await k.runner.rejectDraft(id, kid.actor)).status).toBe('rejected');
	});

	it('does not let a proposer approve their own draft by withdrawing it into place', async () => {
		const id = await propose(kid);
		expect(await code(k.runner.approveDraft(id, kid.actor))).toBe('forbidden');
		expect((await draftRow(id)).status).toBe('pending');
	});
});

describe('a draft about something that is gone', () => {
	it('is closed with a reason instead of waiting forever', async () => {
		const id = await propose(kid);
		things.clear();
		const closed = await k.runner.approveDraft(id, parent.actor);
		expect(closed).toMatchObject({ status: 'rejected', decided_by: parent.member.id });
		const list = await k
			.route('core.listDrafts')
			.call({ actor: parent.actor, query: { limit: 10 } });
		expect(list[0]).toMatchObject({ id, status: 'rejected', reason: 'gone', error: null });
		expect(await waiting(parent)).toEqual({ count: 0 });
		expect(await code(k.runner.approveDraft(id, parent.actor))).toBe('conflict');
	});
});

describe('who decides an addressed draft', () => {
	it('lets a supervised addressee decide their own memory draft, not another’s', async () => {
		const memory = (who: Who) =>
			k.runner.invoke('core.addMemory', { text: 'Likes tea' }, aiFor(who), {
				draft: { sourceKind: 'assistant', sourceId: 't1' },
			});
		const mine = (await memory(kid)) as { draftId: string };
		const route = k.registry.routes.find((r) => r.route.operationId === 'core.approveDraft');
		// The route needs only what a supervised member holds; the runner decides who.
		expect(k.ctx.access.can(kid.actor, route?.route.requires ?? '')).toBe(true);
		expect(k.ctx.access.can(kid.actor, 'core.drafts.approve')).toBe(false);
		expect(await code(k.runner.approveDraft(mine.draftId, sibling.actor))).toBe('not_found');
		expect((await k.runner.approveDraft(mine.draftId, kid.actor)).status).toBe('applied');

		const second = (await memory(kid)) as { draftId: string };
		expect((await k.runner.rejectDraft(second.draftId, kid.actor)).status).toBe('rejected');
	});

	it('keeps a supervised member from approving a draft that is not theirs', async () => {
		const id = await propose(sibling);
		expect(await code(k.runner.approveDraft(id, kid.actor))).toBe('forbidden');
		expect(await code(k.runner.undoDraft(id, kid.actor))).toBe('conflict');
	});
});

describe('the waiting count', () => {
	it('counts only drafts the viewer may decide', async () => {
		await propose(kid);
		await propose(sibling, 'lamp');
		// Approvers see both; a supervised member sees none of them (not even their own).
		expect(await waiting(parent)).toEqual({ count: 2 });
		expect(await waiting(admin)).toEqual({ count: 2 });
		expect(await waiting(kid)).toEqual({ count: 0 });
		await k.runner.rejectDraft(
			(await db().selectFrom('core_drafts').select('id').executeTakeFirstOrThrow()).id,
			parent.actor,
		);
		expect(await waiting(parent)).toEqual({ count: 1 });
	});

	it('counts an addressed draft for its addressee', async () => {
		await k.runner.invoke('core.addMemory', { text: 'Likes tea' }, aiFor(kid));
		expect(await waiting(kid)).toEqual({ count: 1 });
		expect(await waiting(parent)).toEqual({ count: 0 });
	});
});

describe('the waiting notice', () => {
	it('names the action by its translation key, and the thing, when the draft has no summary', async () => {
		await propose(kid);
		k.clock.advance(60_000);
		await k.worker.drain();
		const notes = await db()
			.selectFrom('core_notifications')
			.selectAll()
			.where('kind', '=', 'core.draftWaiting')
			.execute();
		expect(notes.length).toBeGreaterThan(0);
		// The action's translated name, followed by the name of the thing it is about.
		expect(notes.every((n) => n.body_key === 'app:notify_draft_waiting_named')).toBe(true);
		expect(
			notes.every((n) => JSON.parse(n.body_params ?? '{}').what === 'shelf:draft_title_remove'),
		).toBe(true);
	});
});

describe('who reads the suggestion list', () => {
	const listed = async (who: Who) =>
		(
			(await k.route('core.listDrafts').call({
				actor: who.actor,
				query: { status: 'pending', limit: 50 },
			})) as { id: string }[]
		).map((d) => d.id);

	it("keeps one member's suggestions from another who cannot decide them", async () => {
		things.add('chair');
		const kidDraft = await propose(kid);
		const siblingDraft = await propose(sibling, 'chair');
		expect(await listed(kid)).toEqual([kidDraft]);
		expect(await listed(sibling)).toEqual([siblingDraft]);
	});

	it('shows an approver every suggestion they may decide, and the AI draft to the person behind it', async () => {
		const kidDraft = await propose(kid);
		expect(await listed(parent)).toEqual([kidDraft]);
		expect(await listed(admin)).toEqual([kidDraft]);
		things.add('chair');
		const result = await k.runner.invoke('shelf.remove', { name: 'chair' }, aiFor(kid));
		if (result.status !== 'drafted') throw new Error('expected a draft');
		expect(await listed(kid)).toEqual(expect.arrayContaining([kidDraft, result.draftId]));
		expect(await listed(sibling)).toEqual([]);
	});
});

describe('what Quick add shows to decide, and the count of it', () => {
	const shown = (who: Who) =>
		k.route('core.listDrafts').call({ actor: who.actor, query: { limit: 50 } }) as Promise<
			{ id: string; status: string; canDecide: boolean }[]
		>;

	it('tells each reader whether they may decide a suggestion', async () => {
		const id = await propose(kid);
		expect((await shown(parent)).find((d) => d.id === id)?.canDecide).toBe(true);
		// The child sees their own request, waiting for someone else.
		expect((await shown(kid)).find((d) => d.id === id)?.canDecide).toBe(false);
	});

	it('counts exactly the waiting suggestions a reader may decide, failed ones included', async () => {
		things.add('chair');
		const pending = await propose(kid);
		const failed = await propose(kid, 'chair');
		await db()
			.updateTable('core_drafts')
			.set({ status: 'failed' })
			.where('id', '=', failed)
			.execute();
		for (const who of [parent, kid]) {
			const decidable = (await shown(who)).filter(
				(d) => (d.status === 'pending' || d.status === 'failed') && d.canDecide,
			);
			expect((await waiting(who)).count).toBe(decidable.length);
		}
		expect((await waiting(parent)).count).toBe(2);
		expect((await shown(parent)).map((d) => d.id).toSorted()).toEqual([pending, failed].toSorted());
	});
});
