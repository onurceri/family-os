import { type Actor, defineAction, defineCapability, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const shelfUse = defineCapability({ id: 'shelf.use', label: 'shelf:cap_use', level: 'use' });
const shelfManage = defineCapability({
	id: 'shelf.manage',
	label: 'shelf:cap_manage',
	level: 'edit',
});

const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfUse, shelfManage],
	actions: [
		defineAction({
			id: 'shelf.tidy',
			title: 'Tidy the shelf',
			input: z.object({ note: z.string() }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			approval: { unless: shelfManage.id },
			async run() {
				return { ok: true };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let admin: Who;
let kid: Who;
let otherKid: Who;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [shelf] });
	admin = await k.member('admin');
	kid = await k.member('supervised');
	otherKid = await k.member('supervised');
});
afterEach(() => k.close());

const aiFor = (who: Who): Actor => ({
	kind: 'ai',
	mode: 'agent',
	source: 'mcp',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});
const app: Actor = { kind: 'app', appId: 'app_one', roleId: 'member', mode: 'apply' };
const appForKid = (): Actor => ({
	...kid.actor,
	via: { appId: 'app_one', appRoleId: 'member', mode: 'apply' },
});
const display: Actor = { kind: 'display', deviceId: 'dev_one', capabilities: [], showNames: false };

const ids = async (actor: Actor, options?: Parameters<TestKernel['runner']['waitingFor']>[1]) =>
	(await k.runner.waitingFor(actor, options)).map((row) => row.id);

describe('who sees a waiting suggestion', () => {
	it('shows a member their own and those they may decide, and no other caller', async () => {
		const mine = await k.runner.invoke('shelf.tidy', { note: 'a' }, kid.actor);
		if (mine.status !== 'drafted') throw new Error('expected a draft');
		const id = mine.draftId;

		expect(await ids(kid.actor)).toEqual([id]);
		expect(await ids(admin.actor)).toEqual([id]);
		expect(await ids(otherKid.actor)).toEqual([]);
		expect(await ids(aiFor(kid))).toEqual([]);
		expect(await ids(app)).toEqual([]);
		expect(await ids(display)).toEqual([]);
		// An app acting for the member sees what the member sees through its own principal only.
		expect(await ids(appForKid())).toEqual([id]);
		expect(await k.runner.visibleDraftIds(kid.actor, [id])).toEqual(new Set([id]));
		expect(await k.runner.visibleDraftIds(otherKid.actor, [id])).toEqual(new Set());
		expect(await k.runner.visibleDraftIds(app, [id])).toEqual(new Set());
	});

	it('shows an AI proposal to the AI that made it and to the member it was for', async () => {
		const made = await k.runner.invoke('shelf.tidy', { note: 'b' }, aiFor(kid));
		if (made.status !== 'drafted') throw new Error('expected a draft');
		const id = made.draftId;

		expect(await ids(aiFor(kid))).toEqual([id]);
		expect(await ids(kid.actor)).toEqual([id]);
		expect(await ids(otherKid.actor)).toEqual([]);
		expect(await ids(app)).toEqual([]);
		expect(await ids(display)).toEqual([]);
	});

	it('leaves out a suggestion addressed to someone else', async () => {
		const made = await k.runner.invoke('shelf.tidy', { note: 'c' }, kid.actor);
		if (made.status !== 'drafted') throw new Error('expected a draft');
		await k.ctx.db
			.withTables<import('../src/tables.ts').CoreTables>()
			.updateTable('core_drafts')
			.set({ for_member: otherKid.member.id })
			.where('id', '=', made.draftId)
			.execute();
		expect(await ids(admin.actor)).toEqual([]);
		expect(await ids(kid.actor)).toEqual([]);
		expect(await ids(otherKid.actor)).toEqual([]);
	});

	it('narrows to the ones the member may decide, one source, or one state', async () => {
		const made = await k.runner.invoke('shelf.tidy', { note: 'd' }, kid.actor);
		if (made.status !== 'drafted') throw new Error('expected a draft');
		const id = made.draftId;

		expect(await ids(admin.actor, { decidableOnly: true })).toEqual([id]);
		expect(await ids(kid.actor, { decidableOnly: true })).toEqual([]);
		expect(await ids(admin.actor, { about: { draftId: id } })).toEqual([id]);
		expect(await ids(admin.actor, { about: { draftId: 'other' } })).toEqual([]);
		expect(await ids(admin.actor, { statuses: ['failed'] })).toEqual([]);
		expect(await ids(admin.actor, { statuses: ['pending'] })).toEqual([id]);
	});
});
