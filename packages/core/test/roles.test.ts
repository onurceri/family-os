import { defineAction, defineCapability, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from '../src/registry.ts';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notesExtension] });
});
afterEach(() => k.close());

const roles = () => k.route('core.listRoles').call();
const effective = async (id: string) =>
	((await roles()).roles as { id: string; capabilities: string[] }[]).find((r) => r.id === id)
		?.capabilities ?? [];

describe('roles and capabilities', () => {
	it('gives the built-in roles their levels; critical capabilities stay with admins', async () => {
		const admin = await effective('admin');
		expect(admin).toEqual(
			expect.arrayContaining([
				'core.members.manage',
				'core.roles.manage',
				'notes.edit',
				'notes.purge',
			]),
		);
		expect(admin).not.toContain('core.signIn.pin');
		const member = await effective('member');
		expect(member).toEqual(expect.arrayContaining(['core.drafts.approve', 'notes.edit']));
		expect(member).not.toContain('core.members.manage');
		expect(member).not.toContain('notes.purge');
		const supervised = await effective('supervised');
		expect(supervised).toEqual(
			expect.arrayContaining(['core.drafts.propose', 'core.signIn.pin', 'core.members.view']),
		);
		expect(supervised).not.toContain('notes.edit');
		expect(supervised).not.toContain('core.drafts.approve');
		expect(await effective('guest')).toEqual([
			'core.members.view',
			'core.drafts.waiting',
			'core.notifications.receive',
			'core.signIn.pin',
		]);
	});

	it('derives custom roles from a base; capabilities not overridden follow the base', async () => {
		const { actor: admin } = await k.member('admin');
		const created = await k.runner.invoke<{ id: string }>(
			'core.createRole',
			{ name: 'Teen', base: 'supervised', overrides: { 'notes.edit': true } },
			admin,
		);
		if (created.status !== 'applied') throw new Error('expected role');
		const teen = await effective(created.output.id);
		expect(teen).toEqual(
			expect.arrayContaining(['notes.edit', 'core.signIn.pin', 'core.drafts.propose']),
		);
		expect(teen).not.toContain('notes.purge'); // not overridden: the base's default
		const { actor } = await k.member(created.output.id);
		expect((await k.runner.invoke('notes.share', { body: 'x' }, actor)).status).toBe('applied');

		// Changing the role takes effect at once (the cache is refreshed after commit).
		await k.runner.invoke('core.updateRole', { id: created.output.id, overrides: {} }, admin);
		expect((await k.runner.invoke('notes.share', { body: 'x' }, actor)).status).toBe('drafted');
	});

	it('refuses critical, unknown and admin-based roles, and role management by non-admins', async () => {
		const { actor: admin } = await k.member('admin');
		const { actor: member } = await k.member('member');
		const create = (input: unknown, actor = admin) =>
			k.runner.invoke('core.createRole', input, actor);
		await expect(
			create({ name: 'X', base: 'member', overrides: { 'core.members.manage': true } }),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			create({ name: 'X', base: 'member', overrides: { 'notes.typo': true } }),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(create({ name: 'X', base: 'admin' })).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(create({ name: 'X', base: 'member' }, member)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(
			k.runner.invoke('core.createMember', { displayName: 'Y', roleId: 'role_nope' }, admin),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('deletes only roles nobody has', async () => {
		const { actor: admin } = await k.member('admin');
		const created = await k.runner.invoke<{ id: string }>(
			'core.createRole',
			{ name: 'Babysitter', base: 'guest' },
			admin,
		);
		if (created.status !== 'applied') throw new Error('expected role');
		const { member } = await k.member(created.output.id);
		await expect(
			k.runner.invoke('core.deleteRole', { id: created.output.id }, admin),
		).rejects.toMatchObject({ code: 'conflict' });
		await k.runner.invoke('core.updateMember', { memberId: member.id, roleId: 'guest' }, admin);
		expect(
			(await k.runner.invoke('core.deleteRole', { id: created.output.id }, admin)).status,
		).toBe('applied');
	});

	it('keeps PINs and the profile picker to roles that sign in with a PIN', async () => {
		const { member: adminMember } = await k.member('admin');
		const { member: adult } = await k.member('member');
		const { member: kid } = await k.member('supervised');
		const setPin = (memberId: string) =>
			k.route('core.setMemberPin').call({ params: { memberId }, body: { pin: '2468' } });
		await expect(setPin(adminMember.id)).rejects.toMatchObject({ code: 'conflict' });
		await expect(setPin(adult.id)).rejects.toMatchObject({ code: 'conflict' });
		await expect(setPin(kid.id)).resolves.toEqual({ ok: true });
		const profiles = (await k.route('core.listProfiles').call()) as { id: string }[];
		expect(profiles.map((p) => p.id)).toEqual([kid.id]);
	});

	it('lets AI read but never hold a changing capability', () => {
		const ai = { kind: 'ai', source: 'inbox' } as const;
		expect(k.access.can(ai, 'core.members.view')).toBe(true);
		expect(k.access.can(ai, 'notes.edit')).toBe(false);
		expect(k.access.can(systemActor('test'), 'core.roles.manage')).toBe(true);
		expect(() => k.access.can(ai, 'notes.typo')).toThrow(/Unknown capability/);
	});

	it('refuses unsafe definitions at startup', () => {
		const run = async () => ({});
		const base = { title: 't', input: z.object({}), output: z.object({}), run };
		const ext = (
			actions: ReturnType<typeof defineAction>[],
			capabilities = [defineCapability({ id: 'x.edit', label: 'x:edit', level: 'edit' })],
		) => defineTestExtension({ id: 'x', actions, capabilities });
		expect(() => buildRegistry([ext([defineAction({ id: 'x.open', ...base })])])).toThrow(
			/neither/,
		);
		expect(() =>
			buildRegistry([ext([defineAction({ id: 'x.typo', ...base, requires: 'x.edti' })])]),
		).toThrow(/unknown capability/);
		expect(() =>
			buildRegistry([
				ext([
					defineAction({
						id: 'x.direct',
						...base,
						requires: 'x.edit',
						approval: 'never',
						ai: { description: 'd' },
					}),
				]),
			]),
		).toThrow(/AI/);
		expect(() =>
			defineTestExtension({
				id: 'x',
				capabilities: [
					defineCapability({ id: 'x.root', label: 'x:root', level: 'manage', critical: true }),
				],
			}),
		).toThrow(/only core/);
		expect(() =>
			defineTestExtension({
				id: 'x',
				capabilities: [defineCapability({ id: 'y.edit', label: 'y:edit', level: 'edit' })],
			}),
		).toThrow(/namespaced/);
	});

	it('never lets an anonymous caller run an action that changes data or needs a capability', async () => {
		const anonymous = systemActor('anonymous');
		await expect(k.runner.invoke('notes.addNote', { body: 'x' }, anonymous)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.invoke('notes.purge', {}, anonymous)).rejects.toMatchObject({
			code: 'forbidden',
		});
		// Read-only actions without a capability stay available (public routes may use them).
		await expect(k.runner.invoke('notes.countNotes', {}, anonymous)).resolves.toMatchObject({
			status: 'applied',
		});
	});
});
