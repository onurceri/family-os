import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

/** An extension that keeps a credential of its own and ends it when asked; the first try fails. */
const ended: string[] = [];
let failures = 0;
const keeper = defineTestExtension({
	id: 'keeper',
	async endCredentials(_ctx, memberId) {
		if (failures > 0) {
			failures--;
			throw new Error('the database was busy');
		}
		ended.push(memberId);
	},
});

let k: TestKernel;
beforeEach(async () => {
	ended.length = 0;
	failures = 0;
	k = await createTestKernel({ extensions: [keeper] });
});
afterEach(() => k.close());

const tokensOf = async (memberId: string) =>
	(await k.apiTokens.list({ kind: 'member', memberId: memberId as never, roleId: 'member' })).map(
		(t) => t.revokedAt !== null,
	);

async function memberWithToken() {
	const { actor, member } = await k.member('member');
	await k.apiTokens.create(actor, { name: 'Laptop', scope: 'read' });
	expect(await tokensOf(member.id)).toEqual([false]);
	return { actor, member };
}

describe('ending a member’s credentials', () => {
	it('signing out everywhere revokes the keys at once and ends the extension’s credentials from the queue', async () => {
		const { actor, member } = await memberWithToken();
		await k.route('core.signOutEverywhere').call({ actor });
		// The keys end in the same transaction as the sign-out; nothing waits for the worker.
		expect(await tokensOf(member.id)).toEqual([true]);
		expect(ended).toEqual([]);
		await k.worker.drain();
		expect(ended).toEqual([member.id]);
	});

	it('retries a failed first attempt until the credentials end', async () => {
		const { actor, member } = await memberWithToken();
		failures = 1;
		await k.route('core.signOutEverywhere').call({ actor });
		expect(await k.worker.drain()).toBe(0);
		expect(ended).toEqual([]);
		k.clock.advance(60_000);
		expect(await k.worker.drain()).toBe(1);
		expect(ended).toEqual([member.id]);
	});

	it('does the same for a new password and for archiving', async () => {
		const admin = await k.member('admin');
		const pw = await memberWithToken();
		await k.route('core.setMemberPassword').call({
			actor: admin.actor,
			params: { memberId: pw.member.id },
			body: { email: 'pw@example.com', password: 'a long enough password' },
		});
		expect(await tokensOf(pw.member.id)).toEqual([true]);
		await k.worker.drain();
		expect(ended).toEqual([pw.member.id]);

		const gone = await memberWithToken();
		await k.runner.invoke('core.archiveMember', { memberId: gone.member.id }, admin.actor);
		expect(await tokensOf(gone.member.id)).toEqual([true]);
		await k.worker.drain();
		expect(ended).toEqual([pw.member.id, gone.member.id]);
	});

	it('leaves other members alone', async () => {
		const { actor } = await memberWithToken();
		const other = await memberWithToken();
		await k.route('core.signOutEverywhere').call({ actor });
		await k.worker.drain();
		expect(await tokensOf(other.member.id)).toEqual([false]);
		expect(ended).not.toContain(other.member.id);
	});
});
