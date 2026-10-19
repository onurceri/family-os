import {
	type Actor,
	defineAction,
	defineCapability,
	isFamosError,
	type MemberId,
	systemActor,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DraftSchema } from '../src/core-extension.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

type DraftView = z.infer<typeof DraftSchema>;

// An edit saved on a waiting suggestion is the server's: it survives a reload, another approver
// approves it, and only people who may decide it (or are behind it) can save it.
const shelfUse = defineCapability({ id: 'shelf.use', label: 'shelf:cap_use', level: 'use' });
const shelfManage = defineCapability({
	id: 'shelf.manage',
	label: 'shelf:cap_manage',
	level: 'edit',
});
const things: string[] = [];
const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfUse, shelfManage],
	actions: [
		defineAction({
			id: 'shelf.add',
			title: 'Add a thing',
			draftTitle: 'shelf:draft_title_add',
			input: z.object({ name: z.string().min(1).max(20), count: z.number().int().optional() }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			approval: { unless: shelfManage.id },
			async run(_uow, input) {
				things.push(input.name);
				return { ok: true };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let admin: Who;
let otherAdmin: Who;
let kid: Who;
let sibling: Who;
beforeEach(async () => {
	things.length = 0;
	k = await createTestKernel({ extensions: [shelf] });
	admin = await k.member('admin');
	otherAdmin = await k.member('admin');
	kid = await k.member('supervised');
	sibling = await k.member('supervised');
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
const propose = async (who: Who, name = 'lamp') => {
	const result = await k.runner.invoke('shelf.add', { name }, who.actor);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
const edit = (who: Who, draftId: string, input: unknown) =>
	k.runner.invoke('core.editDraft', { draftId, input }, who.actor);
const list = (who: Who) =>
	k.route('core.listDrafts').call({ actor: who.actor, query: { limit: 20 } }) as Promise<
		DraftView[]
	>;
const aiFor = (who: Who, mode: 'share' | 'conversation' = 'share'): Actor => ({
	kind: 'ai',
	mode,
	source: mode === 'share' ? 'inbox' : 'assistant',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});

describe('core.editDraft', () => {
	it('drops the "check this" mark of a field a person changed, and keeps the others', async () => {
		const result = await k.runner.invoke('shelf.add', { name: 'lamp', count: 24 }, aiFor(kid), {
			draft: { uncertainFields: ['count', 'name'] },
		});
		const id = (result as { draftId: string }).draftId;
		const marks = async () => (await list(admin)).find((d) => d.id === id)?.uncertainFields;
		expect(await marks()).toEqual(['count', 'name']);

		// Saved with nothing changed: still guesses.
		await edit(admin, id, { name: 'lamp', count: 24 });
		expect(await marks()).toEqual(['count', 'name']);

		// The person fixed the count and left the name.
		await edit(admin, id, { name: 'lamp', count: 23 });
		expect(await marks()).toEqual(['name']);

		// Put back to what the AI said: the person looked at it, so the mark does not return.
		await edit(admin, id, { name: 'lamp', count: 24 });
		expect(await marks()).toEqual(['name']);

		await edit(admin, id, { name: 'big lamp', count: 24 });
		expect(await marks()).toEqual([]);
	});

	it('stores the edit, so a reload and a second approver see and apply it', async () => {
		const id = await propose(kid);
		await edit(admin, id, { name: 'big lamp', count: 2 });

		const asAdmin = (await list(admin)).find((d) => d.id === id);
		expect(asAdmin).toMatchObject({
			status: 'pending',
			input: { name: 'lamp' },
			editedInput: { name: 'big lamp', count: 2 },
		});
		// Another approver, and the one behind it, read the same edit.
		expect((await list(otherAdmin)).find((d) => d.id === id)?.editedInput).toEqual({
			name: 'big lamp',
			count: 2,
		});
		expect((await list(kid)).find((d) => d.id === id)?.editedInput).toEqual({
			name: 'big lamp',
			count: 2,
		});

		// The other approver approves without sending anything: the saved edit is what runs.
		const done = await k.runner.approveDraft(id, otherAdmin.actor);
		expect(done.status).toBe('applied');
		expect(things).toEqual(['big lamp']);
		expect(done.edited_input && JSON.parse(done.edited_input)).toEqual({
			name: 'big lamp',
			count: 2,
		});
	});

	it('is replaced by an edit sent with the approval, and edited again before it', async () => {
		const id = await propose(kid);
		await edit(admin, id, { name: 'first' });
		await edit(otherAdmin, id, { name: 'second' });
		expect((await list(admin)).find((d) => d.id === id)?.editedInput).toEqual({ name: 'second' });
		await k.runner.approveDraft(id, admin.actor, { name: 'third' });
		expect(things).toEqual(['third']);
	});

	it('lets the member behind a draft edit it, and the AI-made one too', async () => {
		const own = await propose(kid);
		await edit(kid, own, { name: 'mine' });
		const result = await k.runner.invoke('shelf.add', { name: 'ai lamp' }, aiFor(kid), {
			draft: { sourceKind: 'inbox', sourceId: 'item_1' },
		});
		const aiDraft = (result as { draftId: string }).draftId;
		await edit(kid, aiDraft, { name: 'kept' });
		const rows = await list(admin);
		expect(rows.find((d) => d.id === own)?.editedInput).toEqual({ name: 'mine' });
		expect(rows.find((d) => d.id === aiDraft)?.editedInput).toEqual({ name: 'kept' });
	});

	it('is refused for someone who may neither decide it nor is behind it', async () => {
		const id = await propose(kid);
		expect(await code(edit(sibling, id, { name: 'not mine' }))).toBe('forbidden');
		expect((await list(admin)).find((d) => d.id === id)?.editedInput).toBeNull();
	});

	it('is refused for a draft addressed to someone else', async () => {
		const result = await k.runner.invoke('core.addMemory', { text: 'Likes tea' }, aiFor(kid), {
			draft: { sourceKind: 'assistant', sourceId: 't1' },
		});
		const id = (result as { draftId: string }).draftId;
		expect(await code(edit(admin, id, { text: 'Hates tea' }))).toBe('not_found');
	});

	it('validates the input like approving does', async () => {
		const id = await propose(kid);
		expect(await code(edit(admin, id, { name: '' }))).toBe('bad_request');
		expect(await code(edit(admin, id, { name: 'x'.repeat(40) }))).toBe('bad_request');
		expect((await list(admin)).find((d) => d.id === id)?.editedInput).toBeNull();
	});

	it('is refused once the suggestion is decided', async () => {
		const approved = await propose(kid);
		await k.runner.approveDraft(approved, admin.actor);
		expect(await code(edit(admin, approved, { name: 'late' }))).toBe('conflict');

		const rejected = await propose(kid, 'vase');
		await k.runner.rejectDraft(rejected, admin.actor);
		expect(await code(edit(admin, rejected, { name: 'late' }))).toBe('conflict');
		expect(await code(edit(kid, rejected, { name: 'late' }))).toBe('conflict');
	});

	it('is not offered to the AI and needs no approval of its own', async () => {
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).not.toContain('core.editDraft');
		const id = await propose(kid);
		const result = await edit(kid, id, { name: 'mine' });
		expect(result.status).toBe('applied');
	});
});

describe('a suggestion of an extension that is not running', () => {
	const turnOff = () =>
		k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'shelf', enabled: false },
			systemActor('test'),
		);

	it('is shown to everyone who would decide it, with why it waits, and is not counted', async () => {
		const id = await propose(kid);
		expect(await k.route('core.countWaitingDrafts').call({ actor: admin.actor })).toEqual({
			count: 1,
		});
		await turnOff();

		const asAdmin = (await list(admin)).find((d) => d.id === id);
		expect(asAdmin).toMatchObject({
			status: 'pending',
			canDecide: false,
			unavailable: { reason: 'turned_off', extension: 'shelf' },
		});
		expect((await list(kid)).find((d) => d.id === id)?.unavailable).toMatchObject({
			reason: 'turned_off',
		});
		// Someone who neither decides nor proposed it never learns it exists.
		expect((await list(sibling)).find((d) => d.id === id)).toBeUndefined();
		expect(await k.route('core.countWaitingDrafts').call({ actor: admin.actor })).toEqual({
			count: 0,
		});
		// It cannot be approved or edited meanwhile; the person behind it can still withdraw it.
		expect(await code(k.runner.approveDraft(id, admin.actor))).toBe('feature_off');
		expect(await code(edit(admin, id, { name: 'x' }))).toBe('conflict');
		expect(things).toEqual([]);
	});

	it('comes back as an ordinary waiting suggestion', async () => {
		const id = await propose(kid);
		await turnOff();
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'shelf', enabled: true },
			systemActor('test'),
		);
		expect((await list(admin)).find((d) => d.id === id)).toMatchObject({
			canDecide: true,
			unavailable: null,
		});
		expect(await k.route('core.countWaitingDrafts').call({ actor: admin.actor })).toEqual({
			count: 1,
		});
		expect((await k.runner.approveDraft(id, admin.actor)).status).toBe('applied');
	});

	it('lets the proposer withdraw it', async () => {
		const id = await propose(kid);
		await turnOff();
		expect((await k.runner.rejectDraft(id, kid.actor)).status).toBe('rejected');
	});
});

describe('counting what waits', () => {
	const shared = (who: Who, name: string, itemId: string) =>
		k.runner.invoke('shelf.add', { name }, aiFor(who), {
			draft: { sourceKind: 'inbox', sourceId: itemId },
		});

	it('counts the suggestions made from one shared item as one, and any other as it is', async () => {
		await shared(kid, 'a', 'item_1');
		await shared(kid, 'b', 'item_1');
		await shared(kid, 'c', 'item_1');
		await shared(sibling, 'd', 'item_2');
		await propose(kid, 'own request');
		await k.runner.invoke('shelf.add', { name: 'asked' }, aiFor(kid, 'conversation'), {
			draft: { sourceKind: 'assistant', sourceId: 't1' },
		});
		await k.runner.invoke('shelf.add', { name: 'asked 2' }, aiFor(kid, 'conversation'), {
			draft: { sourceKind: 'assistant', sourceId: 't1' },
		});
		// item_1 (3 suggestions) and item_2 are one each; the request and the two assistant ones count as they are.
		expect(await k.route('core.countWaitingDrafts').call({ actor: admin.actor })).toEqual({
			count: 5,
		});
	});

	it('goes down only when the whole share is decided', async () => {
		const first = (await shared(kid, 'a', 'item_1')) as { draftId: string };
		await shared(kid, 'b', 'item_1');
		await k.runner.rejectDraft(first.draftId, admin.actor);
		expect(await k.route('core.countWaitingDrafts').call({ actor: admin.actor })).toEqual({
			count: 1,
		});
	});
});
