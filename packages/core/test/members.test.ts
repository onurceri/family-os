import { FamosError } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, TEST_SETUP_CODE, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel();
});
afterEach(() => k.close());

describe('members and setup', () => {
	it('completes setup exactly once and creates an admin with a password login', async () => {
		expect(await k.route('core.getSetupStatus').call()).toMatchObject({ needsSetup: true });
		const body = {
			displayName: 'Sam',
			email: 'sam@example.com',
			password: 'correct horse battery',
			locale: 'tr',
			setupCode: TEST_SETUP_CODE,
		};
		await expect(
			k.route('core.completeSetup').call({ body: { ...body, setupCode: undefined } }),
		).rejects.toMatchObject({ code: 'forbidden' });
		const admin = await k.route('core.completeSetup').call({ body });
		expect(admin).toMatchObject({ roleId: 'admin', displayName: 'Sam', locale: 'tr' });
		expect(k.passwords.get(admin.id)).toBe('sam@example.com');
		await expect(k.route('core.completeSetup').call({ body })).rejects.toMatchObject({
			code: 'conflict',
		});
	});

	it('protects the last admin', async () => {
		const { actor, member } = await k.member('admin');
		const demote = k.runner.invoke(
			'core.updateMember',
			{ memberId: member.id, roleId: 'member' },
			actor,
		);
		await expect(demote).rejects.toBeInstanceOf(FamosError);
		await expect(demote).rejects.toMatchObject({
			code: 'conflict',
			details: { reason: 'last_admin' },
		});
		await expect(
			k.runner.invoke('core.archiveMember', { memberId: member.id }, actor),
		).rejects.toMatchObject({ code: 'conflict', details: { reason: 'last_admin' } });

		await k.member('admin');
		const ok = await k.runner.invoke(
			'core.updateMember',
			{ memberId: member.id, roleId: 'member' },
			actor,
		);
		expect(ok.status).toBe('applied');
	});

	it('renames a member (up to 60 characters)', async () => {
		const { actor } = await k.member('admin');
		const { member } = await k.member('member');
		const renamed = await k.runner.invoke(
			'core.updateMember',
			{ memberId: member.id, displayName: '  Deniz  ' },
			actor,
		);
		expect(renamed).toMatchObject({ status: 'applied', output: { displayName: 'Deniz' } });
		for (const displayName of ['', '   ', 'x'.repeat(61)]) {
			await expect(
				k.runner.invoke('core.updateMember', { memberId: member.id, displayName }, actor),
			).rejects.toBeDefined();
		}
		const ok = await k.runner.invoke(
			'core.updateMember',
			{ memberId: member.id, displayName: 'y'.repeat(60) },
			actor,
		);
		expect(ok.status).toBe('applied');
	});

	it('removing a member removes their sign-in and hides them', async () => {
		const { actor } = await k.member('admin');
		const { member } = await k.member('member');
		k.passwords.set(member.id, 'member@example.com');
		const removed = await k.runner.invoke('core.archiveMember', { memberId: member.id }, actor);
		expect(removed).toMatchObject({ status: 'applied', output: { archived: true } });
		expect(k.passwords.has(member.id)).toBe(false);
	});

	it('says how each person really signs in, to those who manage people only', async () => {
		const { actor: admin, member: mum } = await k.member('admin');
		const { actor: adult, member: dad } = await k.member('member');
		const { member: teen } = await k.member('supervised');
		const { member: baby } = await k.member('supervised');
		await k.route('core.setMemberPassword').call({
			params: { memberId: dad.id },
			body: { email: 'dad@example.com', password: 'correct horse battery' },
			actor: admin,
		});
		await k.route('core.setMemberPassword').call({
			params: { memberId: teen.id },
			body: { email: 'teen@example.com', password: 'correct horse battery' },
			actor: admin,
		});
		await k
			.route('core.setMemberPin')
			.call({ params: { memberId: teen.id }, body: { pin: '1357' } });
		const list = (await k.route('core.listMembers').call({ actor: admin })) as {
			id: string;
			signIn?: { password: boolean; pin: boolean };
		}[];
		const of = (id: string) => list.find((m) => m.id === id)?.signIn;
		expect(of(mum.id)).toEqual({ password: false, pin: false });
		expect(of(dad.id)).toEqual({ password: true, pin: false });
		expect(of(teen.id)).toEqual({ password: true, pin: true });
		expect(of(baby.id)).toEqual({ password: false, pin: false });
		// Others see the family, not how anyone signs in.
		const seen = (await k.route('core.listMembers').call({ actor: adult })) as object[];
		expect(seen.every((m) => !('signIn' in m))).toBe(true);
		// Everyone sees their own.
		expect(await k.route('core.getMe').call({ actor: adult })).toMatchObject({
			signIn: { password: true, pin: false },
		});
	});

	it('assigns distinct default colors', async () => {
		const a = await k.member('admin');
		const b = await k.member('member');
		expect(a.member.color).not.toBe(b.member.color);
	});
});
