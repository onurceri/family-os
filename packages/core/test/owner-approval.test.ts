import { type Actor, defineAction, defineCapability, FamosError, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// A person's own thing: what they added themselves they may take back without anyone's approval.
const toysUse = defineCapability({ id: 'toys.use', label: 'toys:cap_use', level: 'use' });
const toysManage = defineCapability({ id: 'toys.manage', label: 'toys:cap_manage', level: 'edit' });
/** Toy name → the member who put it on the shelf. */
const shelf = new Map<string, string>();
let ownerReads = 0;
const toys = defineTestExtension({
	id: 'toys',
	capabilities: [toysUse, toysManage],
	actions: [
		defineAction({
			id: 'toys.remove',
			title: 'Remove a toy',
			draftTitle: 'toys:draft_title_remove',
			input: z.object({ name: z.string().min(1) }),
			output: z.object({ ok: z.boolean() }),
			requires: toysUse.id,
			approval: {
				unless: toysManage.id,
				owner: async (_ctx, { name }) => {
					ownerReads += 1;
					return shelf.get(name) ?? null;
				},
			},
			async run(_uow, { name }) {
				if (!shelf.delete(name)) throw new FamosError('not_found', 'Toy not found');
				return { ok: true };
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
	shelf.clear();
	ownerReads = 0;
	k = await createTestKernel({ extensions: [toys] });
	parent = await k.member('member');
	kid = await k.member('supervised');
	sibling = await k.member('supervised');
	shelf.set('kite', kid.member.id);
	shelf.set('ball', sibling.member.id);
});
afterEach(() => k.close());

const remove = (name: string, actor: Actor) => k.runner.invoke('toys.remove', { name }, actor);

describe('the owner of a thing', () => {
	it('removes their own thing directly, without the capability', async () => {
		expect(await remove('kite', kid.actor)).toMatchObject({ status: 'applied' });
		expect(shelf.has('kite')).toBe(false);
	});

	it("still proposes a change to somebody else's thing", async () => {
		expect(await remove('ball', kid.actor)).toMatchObject({ status: 'drafted' });
		expect(shelf.has('ball')).toBe(true);
	});

	it('proposes when the thing belongs to no one', async () => {
		shelf.set('blocks', '');
		expect(await remove('blocks', kid.actor)).toMatchObject({ status: 'drafted' });
	});

	it('is not asked when the capability already lets the person change it', async () => {
		expect(await remove('ball', parent.actor)).toMatchObject({ status: 'applied' });
		expect(ownerReads).toBe(0);
	});

	it('gives the AI nothing: its change for the owner is still a draft', async () => {
		const ai: Actor = {
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			onBehalfOf: kid.member.id as MemberId,
			roleId: kid.actor.roleId,
		};
		expect(await remove('kite', ai)).toMatchObject({ status: 'drafted' });
		expect(shelf.has('kite')).toBe(true);
	});
});
