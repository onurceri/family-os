import {
	type Actor,
	defineAction,
	defineCapability,
	FamosError,
	type MemberId,
	subjectOf,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// Suggestions that are already so, the names they carry, and who can take them back.
const cartUse = defineCapability({ id: 'cart.use', label: 'cart:cap_use', level: 'use' });
const cartEdit = defineCapability({ id: 'cart.edit', label: 'cart:cap_edit', level: 'edit' });
const bought = new Map<string, boolean>();
const cart = defineTestExtension({
	id: 'cart',
	capabilities: [cartUse, cartEdit],
	actions: [
		defineAction({
			id: 'cart.tick',
			title: 'Tick off an item',
			draftTitle: 'cart:draft_title_tick',
			input: z.object({ name: z.string().min(1), done: z.boolean(), label: z.string().optional() }),
			output: z.object({ name: z.string(), done: z.boolean() }),
			requires: cartUse.id,
			approval: { unless: cartEdit.id },
			async settled(_ctx, { name, done }) {
				return bought.has(name) && bought.get(name) === done;
			},
			undo: (item) => ({ actionId: 'cart.tick', input: { name: item.name, done: !item.done } }),
			async run(_uow, { name, done }) {
				if (!bought.has(name)) throw new FamosError('not_found', 'Item not found');
				bought.set(name, done);
				return { name, done };
			},
		}),
		defineAction({
			id: 'cart.remove',
			title: 'Remove an item',
			draftTitle: 'cart:draft_title_remove',
			input: z.object({ id: z.string().min(1) }),
			output: z.object({ id: z.string() }),
			requires: cartUse.id,
			approval: { unless: cartEdit.id },
			async targetTitle(_ctx, { id }) {
				return id === 'item_1' ? 'Swim cap' : null;
			},
			async run(_uow, { id }) {
				return { id };
			},
		}),
		defineAction({
			id: 'cart.addItems',
			title: 'Add items',
			draftTitle: 'cart:draft_title_add_items',
			input: z.object({ items: z.array(z.object({ title: z.string() })) }),
			output: z.object({ count: z.number() }),
			requires: cartUse.id,
			approval: { unless: cartEdit.id },
			async run(_uow, { items }) {
				return { count: items.length };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let parent: Who;
let kid: Who;
let sibling: Who;
beforeEach(async () => {
	bought.clear();
	bought.set('Cheddar', false);
	k = await createTestKernel({ extensions: [cart] });
	parent = await k.member('member');
	kid = await k.member('supervised');
	sibling = await k.member('supervised');
});
afterEach(() => k.close());

const propose = async (input: unknown, actor: Actor, action = 'cart.tick', draft = {}) => {
	const result = await k.runner.invoke(action, input, actor, { draft });
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
const listed = async (who: Who) =>
	(await k.route('core.listDrafts').call({ actor: who.actor, query: { limit: 20 } })) as {
		id: string;
		status: string;
		reason: string | null;
		undoable: boolean;
		error: string | null;
	}[];
const suggestionsOf = async (actor: Actor) => {
	const result = await k.runner.invoke<{
		suggestions: { id: string; label: string; reason?: string }[];
	}>('core.mySuggestions', { limit: 15 }, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output.suggestions;
};
const assistantFor = (who: Who): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});

describe('a suggestion that is already so', () => {
	it('closes as already done when approved, without running or offering an undo', async () => {
		const id = await propose({ name: 'Cheddar', done: true }, kid.actor);
		// Somebody really bought it in the meantime.
		bought.set('Cheddar', true);
		const closed = await k.runner.approveDraft(id, parent.actor);
		expect(closed).toMatchObject({ status: 'rejected', decided_by: parent.member.id });

		const [view] = await listed(parent);
		expect(view).toMatchObject({
			id,
			status: 'rejected',
			reason: 'settled',
			undoable: false,
			error: null,
		});
		// Nothing was applied, so there is nothing to undo, and the item stays bought.
		expect(k.runner.undoStep(closed)).toBeNull();
		expect(bought.get('Cheddar')).toBe(true);
		const audit = await k.ctx.db
			.withTables<import('../src/tables.ts').CoreTables>()
			.selectFrom('core_audit_log')
			.selectAll()
			.where('draft_id', '=', id)
			.execute();
		expect(audit.map((a) => a.outcome)).toEqual(['drafted', 'rejected']);
		await expect(k.runner.approveDraft(id, parent.actor)).rejects.toMatchObject({
			code: 'conflict',
		});
	});

	it('judges the edited input when the approver changed it', async () => {
		const id = await propose({ name: 'Cheddar', done: true }, kid.actor);
		bought.set('Cheddar', true);
		// Edited to unticking: that is not yet so, so it runs.
		const applied = await k.runner.approveDraft(id, parent.actor, { name: 'Cheddar', done: false });
		expect(applied.status).toBe('applied');
		expect(bought.get('Cheddar')).toBe(false);
	});

	it('applies, and can be undone, when it is not already so', async () => {
		const id = await propose({ name: 'Cheddar', done: true }, kid.actor);
		const applied = await k.runner.approveDraft(id, parent.actor);
		expect(applied.status).toBe('applied');
		expect(k.runner.undoStep(applied)).toMatchObject({ actionId: 'cart.tick' });
		const [view] = await listed(parent);
		expect(view).toMatchObject({ status: 'applied', reason: null, undoable: true });
	});

	it('says so in the proposer’s own suggestion list', async () => {
		const id = await propose({ name: 'Cheddar', done: true }, assistantFor(kid));
		bought.set('Cheddar', true);
		await k.runner.approveDraft(id, parent.actor);
		const mine = await suggestionsOf(kid.actor);
		expect(mine.find((s) => s.id === id)).toMatchObject({ reason: 'settled' });
	});
});

const waitingNotices = () =>
	k.ctx.db
		.withTables<import('../src/tables.ts').CoreTables>()
		.selectFrom('core_notifications')
		.selectAll()
		.where('kind', '=', 'core.draftWaiting')
		.execute();

describe('the name a suggestion carries', () => {
	it('is its label, a new thing’s title, or the joined titles of several', async () => {
		await propose({ name: 'Cheddar', done: true, label: 'Cheddar' }, assistantFor(parent));
		await propose(
			{ items: [{ title: 'Milk' }, { title: 'Eggs' }] },
			assistantFor(parent),
			'cart.addItems',
		);
		const labels = (await suggestionsOf(parent.actor)).map((s) => s.label);
		expect(labels).toContain('Tick off an item: Cheddar');
		expect(labels).toContain('Add items: Milk, Eggs');
	});

	it('reaches the approvers’ notice as a translated parameter', async () => {
		await propose({ name: 'Cheddar', done: true, label: 'Cheddar' }, kid.actor);
		k.clock.advance(60_000);
		await k.worker.drain();
		const notes = await k.ctx.db
			.withTables<import('../src/tables.ts').CoreTables>()
			.selectFrom('core_notifications')
			.selectAll()
			.where('kind', '=', 'core.draftWaiting')
			.execute();
		expect(notes.length).toBeGreaterThan(0);
		for (const note of notes) {
			expect(note.body_key).toBe('app:notify_draft_waiting_named_by');
			expect(JSON.parse(note.body_params ?? '{}')).toEqual({
				what: 'cart:draft_title_tick',
				name: 'Cheddar',
				who: kid.member.displayName,
			});
		}
	});

	it('comes from the stored name when the screen sent only an id', async () => {
		await propose({ id: 'item_1' }, kid.actor, 'cart.remove');
		k.clock.advance(60_000);
		await k.worker.drain();
		const notes = await waitingNotices();
		expect(notes.length).toBeGreaterThan(0);
		for (const note of notes)
			expect(JSON.parse(note.body_params ?? '{}')).toEqual({
				what: 'cart:draft_title_remove',
				name: 'Swim cap',
				who: kid.member.displayName,
			});
	});

	it('is read from the input by subjectOf', () => {
		expect(subjectOf(JSON.stringify({ id: 'x', label: ' Cheddar ' }))).toBe('Cheddar');
		expect(subjectOf(JSON.stringify({ title: 'Call', label: 'Other' }))).toBe('Call');
		expect(
			subjectOf(JSON.stringify({ items: [{ title: 'A' }, { title: ' ' }, { title: 'B' }] })),
		).toBe('A, B');
		expect(subjectOf(JSON.stringify({ id: 'x' }))).toBeUndefined();
		expect(subjectOf('not json')).toBeUndefined();
	});
});

describe('a suggestion read from something a member shared', () => {
	const inbox: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };

	it('belongs to the sharer, who may take it back even without approving', async () => {
		const id = await propose({ name: 'Cheddar', done: true }, inbox, 'cart.tick', {
			sourceKind: 'inbox',
			sourceId: 'inbox_1',
			forMember: kid.member.id,
		});
		const row = await k.ctx.db
			.withTables<import('../src/tables.ts').CoreTables>()
			.selectFrom('core_drafts')
			.select('proposed_by')
			.where('id', '=', id)
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.proposed_by)).toMatchObject({
			kind: 'ai',
			mode: 'share',
			source: 'inbox',
			onBehalfOf: kid.member.id,
		});
		expect(k.ctx.access.can(kid.actor, 'core.drafts.approve')).toBe(false);
		await expect(k.runner.rejectDraft(id, sibling.actor)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect((await suggestionsOf(kid.actor)).map((s) => s.id)).toContain(id);
		const closed = await k.runner.rejectDraft(id, kid.actor);
		expect(closed).toMatchObject({ status: 'rejected', decided_by: kid.member.id });
		// Taking back what their own share produced reads as withdrawn.
		const [view] = await listed(kid);
		expect(view).toMatchObject({ id, status: 'rejected', reason: 'withdrawn' });
	});

	it('a rejected assistant suggestion is not called withdrawn, a person’s own is', async () => {
		const ai = await propose({ name: 'Cheddar', done: true }, assistantFor(parent));
		await k.runner.rejectDraft(ai, parent.actor);
		const own = await propose({ name: 'Cheddar', done: true }, kid.actor);
		await k.runner.rejectDraft(own, kid.actor);
		const byId = new Map((await listed(parent)).map((d) => [d.id, d.reason]));
		expect(byId.get(ai)).toBeNull();
		expect(byId.get(own)).toBe('withdrawn');
	});
});

describe('the waiting notice once the suggestion is decided', () => {
	const sourced = { sourceKind: 'inbox', sourceId: 'inbox_9' };
	const unread = async () => (await waitingNotices()).filter((n) => n.read_at === null);

	it('is read when the suggestion is rejected, applied or withdrawn', async () => {
		for (const decide of ['reject', 'approve', 'withdraw'] as const) {
			const id = await propose({ id: 'item_1' }, kid.actor, 'cart.remove');
			k.clock.advance(60_000);
			await k.worker.drain();
			expect((await unread()).length).toBeGreaterThan(0);
			if (decide === 'approve') await k.runner.approveDraft(id, parent.actor);
			else await k.runner.rejectDraft(id, decide === 'reject' ? parent.actor : kid.actor);
			expect(await unread()).toEqual([]);
		}
	});

	it('stays unread while another suggestion of the same message waits', async () => {
		const first = await propose({ name: 'Cheddar', done: true }, kid.actor, 'cart.tick', sourced);
		const second = await propose({ id: 'item_1' }, kid.actor, 'cart.remove', sourced);
		k.clock.advance(60_000);
		await k.worker.drain();
		expect((await unread()).length).toBeGreaterThan(0);
		await k.runner.rejectDraft(first, parent.actor);
		expect((await unread()).length).toBeGreaterThan(0);
		await k.runner.rejectDraft(second, parent.actor);
		expect(await unread()).toEqual([]);
	});

	it('is never made when the suggestion was decided during the delay', async () => {
		const id = await propose({ id: 'item_1' }, kid.actor, 'cart.remove');
		await k.runner.rejectDraft(id, kid.actor);
		k.clock.advance(60_000);
		await k.worker.drain();
		expect(await waitingNotices()).toEqual([]);
	});
});
