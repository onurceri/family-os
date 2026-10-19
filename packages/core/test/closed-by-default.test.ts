import {
	type Actor,
	defineAction,
	defineCapability,
	type MemberId,
	memberBehind,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NESTED_NEEDS_APPROVAL } from '../src/action-runner.ts';
import { admission, approval, type DecideEnv, decide } from '../src/decide.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const cupsUse = defineCapability({ id: 'cups.use', label: 'cups:cap_use', level: 'use' });
const cupsEdit = defineCapability({ id: 'cups.edit', label: 'cups:cap_edit', level: 'edit' });

/** What the inner action did: it must stay empty whenever the nested run is refused. */
const poured: string[] = [];
const Name = z.object({ name: z.string() });
const Done = z.object({ ok: z.boolean() });

const pour = defineAction({
	id: 'cups.pour',
	title: 'Pour a cup',
	draftTitle: 'cups:draft_pour',
	input: Name,
	output: Done,
	requires: cupsUse.id,
	approval: { unless: cupsEdit.id },
	async run(_uow, { name }) {
		poured.push(name);
		return { ok: true };
	},
});
// Done by whoever may use cups: it pours through `cups.pour`, which asks more of the one
// who is not allowed to edit.
const serve = defineAction({
	id: 'cups.serve',
	title: 'Serve a cup',
	input: Name,
	output: Done,
	requires: cupsUse.id,
	approval: 'never',
	run: (uow, input) => uow.run('cups.pour', input),
});
// The same, but the person serving needs approval for the serving itself.
const serveChecked = defineAction({
	id: 'cups.serveChecked',
	title: 'Serve a cup after a check',
	draftTitle: 'cups:draft_serve',
	input: Name,
	output: Done,
	requires: cupsUse.id,
	approval: { unless: cupsEdit.id },
	run: (uow, input) => uow.run('cups.pour', input),
});
// Reads are never held back by a nested run.
const peek = defineAction({
	id: 'cups.peek',
	title: 'Peek into a cup',
	input: Name,
	output: z.number(),
	readOnly: true,
	requires: cupsUse.id,
	run: async () => poured.length,
});
const peekFirst = defineAction({
	id: 'cups.peekFirst',
	title: 'Peek, through another action',
	input: Name,
	output: z.number(),
	readOnly: true,
	requires: cupsUse.id,
	run: (uow, input) => uow.run('cups.peek', input),
});

const cups = defineTestExtension({
	id: 'cups',
	capabilities: [cupsUse, cupsEdit],
	actions: [pour, serve, serveChecked, peek, peekFirst],
});

const env = (k: TestKernel): DecideEnv => ({
	access: k.access,
	critical: new Set(k.registry.capabilities.filter((c) => c.critical).map((c) => c.id)),
});

/** A kind the code does not know: only reachable by a cast, as a future kind would be. */
const fake = { kind: 'robot', id: 'r1' } as unknown as Actor;

let k: TestKernel;
beforeEach(async () => {
	poured.length = 0;
	k = await createTestKernel({ extensions: [cups] });
});
afterEach(() => k.close());

describe('an actor kind nobody knows', () => {
	it('is refused every action by admission, read-only or not', () => {
		for (const def of [pour, peek]) {
			expect(admission(def, fake, env(k))).toMatchObject({ reason: expect.any(String) });
			expect(decide(def, fake, env(k)).outcome).toBe('refuse');
		}
	});

	it('holds no capability', () => {
		expect(k.access.can(fake, cupsUse.id)).toBe(false);
		expect(k.access.can(fake, 'core.members.view')).toBe(false);
		expect(k.access.memberCan(fake, cupsUse.id)).toBe(false);
	});

	it('would need approval for any change, were it ever asked', () => {
		expect(approval(pour, fake, env(k), undefined)).toMatchObject({ needed: true });
		expect(approval(serve, fake, env(k), undefined)).toMatchObject({ needed: true });
		expect(approval(peek, fake, env(k), undefined)).toEqual({ needed: false });
	});

	it('runs nothing through the runner', async () => {
		await expect(k.runner.invoke('cups.serve', { name: 'tea' }, fake)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect(poured).toEqual([]);
	});

	it('has no member behind it and a name for audit', () => {
		expect(memberBehind(fake)).toBeNull();
	});
});

describe('an action run inside another', () => {
	it('is applied for who may make that change directly', async () => {
		const admin = await k.member('admin');
		const member = await k.member('member');
		for (const who of [admin, member]) {
			poured.length = 0;
			const result = await k.runner.invoke('cups.serve', { name: 'tea' }, who.actor);
			expect(result.status).toBe('applied');
			expect(poured).toEqual(['tea']);
		}
	});

	it('is refused, not applied, when the actor would only be allowed to suggest it', async () => {
		const kid = await k.member('supervised');
		await expect(k.runner.invoke('cups.serve', { name: 'tea' }, kid.actor)).rejects.toMatchObject({
			code: 'forbidden',
			details: { reason: NESTED_NEEDS_APPROVAL, capability: cupsEdit.id },
		});
		expect(poured).toEqual([]);
	});

	it('is refused for a role that may neither make nor suggest it', async () => {
		const admin = await k.member('admin');
		const made = await k.runner.invoke<{ id: string }>(
			'core.createRole',
			{ name: 'Helper', base: 'guest', overrides: { [cupsUse.id]: true } },
			admin.actor,
		);
		if (made.status !== 'applied') throw new Error('role not created');
		const helper = await k.member(made.output.id);
		await expect(
			k.runner.invoke('cups.serve', { name: 'tea' }, helper.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect(poured).toEqual([]);
	});

	it('is applied when a person approves the outer suggestion, whoever the approver is', async () => {
		const admin = await k.member('admin');
		const kid = await k.member('supervised');
		const suggested = await k.runner.invoke('cups.serveChecked', { name: 'milk' }, kid.actor);
		if (suggested.status !== 'drafted')
			throw new Error(`expected a draft, got ${suggested.status}`);
		expect(poured).toEqual([]);
		const applied = await k.runner.approveDraft(suggested.draftId, admin.actor);
		expect(applied.status).toBe('applied');
		expect(poured).toEqual(['milk']);
	});

	it('lets a read through whoever asks', async () => {
		const kid = await k.member('supervised');
		const result = await k.runner.invoke('cups.peekFirst', { name: 'x' }, kid.actor);
		expect(result).toMatchObject({ status: 'applied', output: 0 });
	});

	it('keeps the system allowed where it is today (the queue, jobs, restore)', async () => {
		const result = await k.runner.invoke(
			'cups.serve',
			{ name: 'tea' },
			{
				kind: 'system',
				source: 'queue',
			},
		);
		expect(result.status).toBe('applied');
		expect(poured).toEqual(['tea']);
	});

	it('is refused for the AI, which only ever suggests', async () => {
		const kid = await k.member('supervised');
		const ai: Actor = {
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			onBehalfOf: kid.member.id as MemberId,
			roleId: kid.actor.roleId,
		};
		// The outer action is not offered to the AI, so it is a draft whose approval applies it.
		const result = await k.runner.invoke('cups.serve', { name: 'tea' }, ai);
		expect(result.status).toBe('drafted');
		expect(poured).toEqual([]);
	});
});

describe('only a person present decides a suggestion', () => {
	const others: [string, Actor][] = [
		['the system', { kind: 'system', source: 'queue' }],
		['the AI', { kind: 'ai', mode: 'agent', source: 'mcp' }],
		[
			'a display',
			{ kind: 'display', deviceId: 'dev_1', capabilities: ['cups.use'], showNames: false },
		],
		['a kind nobody knows', fake],
	];

	it.each(others)(
		'does not let %s approve, reject, edit or take one back',
		async (_name, actor) => {
			const kid = await k.member('supervised');
			const suggested = await k.runner.invoke('cups.serveChecked', { name: 'milk' }, kid.actor);
			if (suggested.status !== 'drafted') throw new Error('expected a draft');
			const draftId = suggested.draftId;
			await expect(k.runner.approveDraft(draftId, actor)).rejects.toMatchObject({
				code: 'forbidden',
			});
			await expect(k.runner.rejectDraft(draftId, actor)).rejects.toMatchObject({
				code: 'forbidden',
			});
			// The AI's edit is only a suggestion of its own; nothing is edited until a person decides.
			const edit = await k.runner
				.invoke('core.editDraft', { draftId, input: { name: 'water' } }, actor)
				.then(
					(result) => result.status,
					(error: { code: string }) => error.code,
				);
			expect(['forbidden', 'not_found', 'drafted']).toContain(edit);
			expect(poured).toEqual([]);
			// Still waiting for a person.
			const approved = await k.runner.approveDraft(draftId, (await k.member('admin')).actor);
			expect(approved.status).toBe('applied');
			expect(poured).toEqual(['milk']);
		},
	);
});
