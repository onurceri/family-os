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
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// A suggestion to add a thing that is already there may become a move of that thing instead.
const shelfUse = defineCapability({ id: 'shelf.use', label: 'shelf:cap_use', level: 'use' });
const shelfEdit = defineCapability({ id: 'shelf.edit', label: 'shelf:cap_edit', level: 'edit' });
const shelfArrange = defineCapability({
	id: 'shelf.arrange',
	label: 'shelf:cap_arrange',
	level: 'manage',
});

/** Things by id: their name and where they are. */
const things = new Map<string, { name: string; place: string }>();

const add = defineAction({
	id: 'shelf.add',
	title: 'Add a thing',
	draftTitle: 'shelf:draft_title_add',
	input: z.object({ title: z.string().min(1), place: z.string().min(1) }),
	output: z.object({ id: z.string() }),
	requires: shelfUse.id,
	approval: { unless: shelfEdit.id },
	// Deliberately careless: it offers the first thing there, whatever it is called, so the
	// runner's own check that the draft's words name it is what keeps an unrelated thing out.
	instead: async (_ctx, input) => {
		const first = [...things.entries()][0];
		return first
			? {
					actionId: 'shelf.move',
					input: { id: first[0], place: input.place },
					at: { date: '2026-11-07', time: '18:00' },
				}
			: null;
	},
	async run(_uow, input) {
		const id = `thing_${things.size + 1}`;
		things.set(id, { name: input.title, place: input.place });
		return { id };
	},
});

const move = defineAction({
	id: 'shelf.move',
	title: 'Move a thing',
	draftTitle: 'shelf:draft_title_move',
	input: z.object({ id: z.string(), place: z.string().min(1), label: z.string().optional() }),
	output: z.object({ id: z.string(), before: z.string() }),
	requires: shelfUse.id,
	approval: { unless: shelfArrange.id },
	targetTitle: async (_ctx, input) => things.get(input.id)?.name ?? null,
	undo: ({ id, before }) => ({ actionId: 'shelf.move', input: { id, place: before } }),
	async run(_uow, input) {
		const thing = things.get(input.id);
		if (!thing) throw new FamosError('not_found', 'Thing not found');
		const before = thing.place;
		thing.place = input.place;
		return { id: input.id, before };
	},
});

const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfUse, shelfEdit, shelfArrange],
	actions: [add, move],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let admin: Who;
let parent: Who;
let kid: Who;
beforeEach(async () => {
	things.clear();
	things.set('thing_lamp', { name: 'Reading lamp', place: 'hall' });
	k = await createTestKernel({ extensions: [shelf] });
	admin = await k.member('admin');
	parent = await k.member('member');
	kid = await k.member('supervised');
});
afterEach(() => k.close());

const db = () => k.ctx.db.withTables<CoreTables>();
const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
	return 'ok';
};
const propose = async (actor: Actor, title = 'reading lamp', place = 'study') => {
	const result = await k.runner.invoke('shelf.add', { title, place }, actor);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
const listed = async (who: Who, id: string) =>
	(
		(await k.route('core.listDrafts').call({ actor: who.actor, query: { limit: 20 } })) as {
			id: string;
		}[]
	).find((d) => d.id === id);
const waiting = (who: Who) =>
	k.route('core.countWaitingDrafts').call({ actor: who.actor }) as Promise<{ count: number }>;
const replace = (who: Who, draftId: string) =>
	k.route('core.replaceDraft').call({ actor: who.actor, params: { draftId } });

describe('a draft that offers to change what is already there', () => {
	it('lists the alternative under the real name of what it changes', async () => {
		const id = await propose(kid.actor);
		expect(await listed(admin, id)).toMatchObject({
			actionId: 'shelf.add',
			instead: {
				actionId: 'shelf.move',
				input: { id: 'thing_lamp', place: 'study', label: 'Reading lamp' },
				at: { date: '2026-11-07', time: '18:00' },
			},
			replacedFrom: null,
		});
	});

	it('never offers a thing the draft does not name', async () => {
		const id = await propose(kid.actor, 'Bookshelf');
		expect(await listed(admin, id)).toMatchObject({ instead: null });
		expect(await code(replace(admin, id))).toBe('conflict');
	});

	it('becomes the change, still waiting, with what it was before kept', async () => {
		const id = await propose(kid.actor);
		const view = await replace(admin, id);
		expect(view).toMatchObject({
			status: 'pending',
			actionId: 'shelf.move',
			input: { id: 'thing_lamp', place: 'study', label: 'Reading lamp' },
			replacedFrom: 'shelf.add',
			instead: null,
		});
		const row = await db()
			.selectFrom('core_drafts')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.replaced as string)).toEqual({
			actionId: 'shelf.add',
			input: { title: 'reading lamp', place: 'study' },
		});
		const audit = await db()
			.selectFrom('core_audit_log')
			.selectAll()
			.where('draft_id', '=', id)
			.orderBy('id')
			.execute();
		expect(audit.map((a) => [a.action_id, a.outcome])).toEqual([
			['shelf.add', 'drafted'],
			['shelf.add', 'replaced'],
		]);
		expect(JSON.parse(audit[1]?.actor ?? '{}')).toMatchObject({ memberId: admin.member.id });
		// Nothing changed yet, and nothing was added.
		expect(things.get('thing_lamp')?.place).toBe('hall');
		expect(things.size).toBe(1);
		// Choosing it again changes nothing.
		expect(await replace(admin, id)).toMatchObject({ actionId: 'shelf.move' });
	});

	it('is chosen only by someone who may decide both the draft and the change', async () => {
		const id = await propose(kid.actor);
		// The supervised member behind it cannot decide it, so cannot turn it into something else.
		expect(await code(replace(kid, id))).toBe('forbidden');
		// The parent may approve adding, not moving: they cannot make it a move.
		expect(await code(replace(parent, id))).toBe('forbidden');
		expect((await listed(admin, id)) as unknown).toMatchObject({ actionId: 'shelf.add' });
		await replace(admin, id);
		// It still waits for an approver; the kid sees it, waiting.
		expect(await waiting(admin)).toEqual({ count: 1 });
		expect(await waiting(kid)).toEqual({ count: 0 });
		expect(await listed(kid, id)).toMatchObject({ status: 'pending', actionId: 'shelf.move' });
		expect(await code(k.runner.approveDraft(id, parent.actor))).toBe('forbidden');
		expect(await code(k.runner.approveDraft(id, kid.actor))).toBe('forbidden');
	});

	it('is approved like any change, and undone with the change’s undo', async () => {
		const ai: Actor = {
			kind: 'ai',
			mode: 'share',
			source: 'inbox',
			onBehalfOf: kid.member.id as MemberId,
			roleId: kid.actor.roleId,
		};
		const id = await propose(ai);
		await replace(admin, id);
		const applied = await k.runner.approveDraft(id, admin.actor);
		expect(applied).toMatchObject({ status: 'applied', action_id: 'shelf.move' });
		expect(things.get('thing_lamp')?.place).toBe('study');
		expect(things.size).toBe(1);
		expect(await k.runner.undoDraft(id, admin.actor)).toMatchObject({ status: 'undone' });
		expect(things.get('thing_lamp')?.place).toBe('hall');
	});

	it('is not offered once the draft is decided', async () => {
		const id = await propose(kid.actor);
		await k.runner.rejectDraft(id, admin.actor);
		expect(await listed(admin, id)).toMatchObject({ status: 'rejected', instead: null });
		expect(await code(replace(admin, id))).toBe('conflict');
	});
});
