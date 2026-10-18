import { type Actor, defineAction, defineCapability, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// The assistant acts for the member who asked: never beyond them, never beyond the AI.
const stashView = defineCapability({
	id: 'stash.view',
	label: 'stash:cap_view',
	level: 'view',
	defaults: { admin: true, member: true, supervised: false, guest: false },
});
const shelfView = defineCapability({ id: 'shelf.view', label: 'shelf:cap_view', level: 'view' });
const shelfEdit = defineCapability({ id: 'shelf.edit', label: 'shelf:cap_edit', level: 'edit' });

const reader = (id: string, requires: string) =>
	defineAction({
		id,
		title: id,
		input: z.object({}),
		output: z.object({ text: z.string() }),
		readOnly: true,
		requires,
		ai: { description: `reads ${id}` },
		async run() {
			return { text: 'contents' };
		},
	});
const stash = defineTestExtension({
	id: 'stash',
	capabilities: [stashView],
	actions: [reader('stash.list', stashView.id)],
});
const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfView, shelfEdit],
	actions: [
		reader('shelf.list', shelfView.id),
		defineAction({
			id: 'shelf.add',
			title: 'Add',
			input: z.object({ name: z.string() }),
			output: z.object({ ok: z.boolean() }),
			approval: { unless: shelfEdit.id },
			ai: { description: 'adds a thing' },
			async run() {
				return { ok: true };
			},
		}),
		defineAction({
			id: 'shelf.rename',
			title: 'Rename',
			input: z.object({}),
			output: z.object({}),
			requires: shelfEdit.id,
			ai: { description: 'renames a thing' },
			async run() {
				return {};
			},
		}),
	],
});

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [stash, shelf] });
});
afterEach(() => k.close());

async function asking(roleId: string) {
	const { actor, member } = await k.member(roleId);
	const ai: Actor = {
		kind: 'ai',
		mode: 'conversation',
		source: 'assistant',
		onBehalfOf: member.id as MemberId,
		roleId,
	};
	return { actor, ai, member };
}
const readIds = (actor: Actor) =>
	k.ctx.actions
		.aiReadTools({ actor })
		.map((a) => a.id)
		.filter((id) => !id.startsWith('core.'))
		.sort();
// Core's own personal tools (memory, suggestions) are tested in memory.test.ts and my-suggestions.test.ts.
const draftIds = (actor: Actor) =>
	k.ctx.actions
		.aiCatalog({ actor })
		.map((a) => a.id)
		.filter((id) => !id.startsWith('core.'))
		.sort();

describe('the AI acting on behalf of a member', () => {
	it('holds only capabilities the member holds, on top of the AI’s own limits', async () => {
		const adult = await asking('member');
		const kid = await asking('supervised');
		const anyone: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
		expect(k.access.can(adult.ai, 'stash.view')).toBe(true);
		expect(k.access.can(kid.ai, 'stash.view')).toBe(false);
		expect(k.access.can(kid.ai, 'shelf.view')).toBe(true);
		// Still a reader: the AI never holds change capabilities, whoever asks.
		expect(k.access.can(adult.ai, 'shelf.edit')).toBe(false);
		expect(k.access.can(anyone, 'stash.view')).toBe(true);
		// An unknown role holds nothing.
		expect(k.access.can({ ...adult.ai, roleId: 'role_gone' }, 'shelf.view')).toBe(false);
		expect(k.access.can({ ...adult.ai, roleId: undefined }, 'shelf.view')).toBe(false);
	});

	it('offers read tools by what the member may read', async () => {
		const adult = await asking('member');
		const kid = await asking('supervised');
		expect(readIds(adult.ai)).toEqual(['shelf.list', 'stash.list']);
		expect(readIds(kid.ai)).toEqual(['shelf.list']);
		// No member: everything the sandbox allows.
		expect(readIds({ kind: 'ai', mode: 'share', source: 'inbox' })).toEqual([
			'shelf.list',
			'stash.list',
		]);
		// Read tools are not draft tools.
		expect(draftIds(adult.ai)).not.toContain('shelf.list');
	});

	it('offers draft tools by what the member could do or propose', async () => {
		const adult = await asking('member');
		const kid = await asking('supervised');
		const guest = await asking('guest');
		expect(draftIds(adult.ai)).toEqual(['shelf.add', 'shelf.rename']);
		// A supervised member may propose but not rename (needs shelf.edit).
		expect(draftIds(kid.ai)).toEqual(['shelf.add']);
		// A guest can neither edit nor propose.
		expect(draftIds(guest.ai)).toEqual([]);
	});

	it('refuses what the member could not read, even if called directly', async () => {
		const adult = await asking('member');
		const kid = await asking('supervised');
		await expect(k.runner.invoke('stash.list', {}, adult.ai)).resolves.toMatchObject({
			status: 'applied',
		});
		await expect(k.runner.invoke('stash.list', {}, kid.ai)).rejects.toMatchObject({
			code: 'forbidden',
		});
	});

	it('is still closed by an area that is off', async () => {
		const adult = await asking('admin');
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'stash', access: 'off' },
			adult.actor,
		);
		await expect(k.runner.invoke('stash.list', {}, adult.ai)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect(readIds(adult.ai)).toEqual(['shelf.list']);
		await expect(k.runner.invoke('stash.list', {}, adult.actor)).resolves.toMatchObject({
			status: 'applied',
		});
	});

	it('only drafts, recording the proposer and the member, even when the member could apply', async () => {
		const adult = await asking('member');
		const result = await k.runner.invoke('shelf.add', { name: 'x' }, adult.ai);
		expect(result.status).toBe('drafted');
		const row = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.proposed_by)).toMatchObject({
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: adult.member.id,
		});
		expect(row.status).toBe('pending');
	});

	it('refuses a draft the member could not make or propose', async () => {
		const guest = await asking('guest');
		const kid = await asking('supervised');
		await expect(k.runner.invoke('shelf.add', { name: 'x' }, guest.ai)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.invoke('shelf.rename', {}, kid.ai)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.invoke('shelf.add', { name: 'x' }, kid.ai)).resolves.toMatchObject({
			status: 'drafted',
		});
	});

	it('leaves approval to people who may approve: the supervised asker cannot approve their own', async () => {
		const kid = await asking('supervised');
		const adult = await asking('member');
		const drafted = await k.runner.invoke<unknown>('shelf.add', { name: 'x' }, kid.ai);
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await expect(k.runner.approveDraft(drafted.draftId, kid.actor)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.approveDraft(drafted.draftId, adult.actor)).resolves.toMatchObject({
			status: 'applied',
		});
	});

	it('never lists actions of an area that is off or local-only for the model', async () => {
		const admin = await asking('admin');
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'shelf', access: 'local' },
			admin.actor,
		);
		expect(readIds(admin.ai)).toEqual(['stash.list']);
		expect(
			k.ctx.actions
				.aiReadTools({ actor: { ...admin.ai, local: true }, local: true })
				.map((a) => a.id)
				.filter((id) => !id.startsWith('core.'))
				.sort(),
		).toEqual(['shelf.list', 'stash.list']);
	});
});
