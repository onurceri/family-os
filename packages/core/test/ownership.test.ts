import type { Actor, FamosError, MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

// An AI draft belongs to the person behind it when they could decide it themselves.

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let adult: Awaited<ReturnType<TestKernel['member']>>;
let child: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notesExtension] });
	admin = await k.member('admin');
	adult = await k.member('member');
	child = await k.member('supervised');
});
afterEach(() => k.close());

const db = () => k.ctx.db.withTables<CoreTables>();
const ACTION = 'notes.addNote';
const row = (id: string) =>
	db().selectFrom('core_drafts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const noticeRecipients = async () => {
	k.clock.advance(60_000);
	await k.worker.drain();
	return (
		await db()
			.selectFrom('core_notifications')
			.select('member_id')
			.where('kind', '=', 'core.draftWaiting')
			.execute()
	)
		.map((n) => n.member_id)
		.sort();
};
/** A share from the Inbox: the AI, working for nobody in particular, for one member. */
const fromInbox = async (forMember: string, body = 'Meeting') => {
	const result = await k.runner.invoke(
		ACTION,
		{ body },
		{ kind: 'ai', mode: 'share', source: 'inbox' },
		{ draft: { sourceKind: 'inbox', sourceId: `item-${body}`, forMember } },
	);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
const assistantFor = (m: { member: { id: string }; actor: Actor }, roleId: string): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: m.member.id as MemberId,
	roleId,
});
const code = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: FamosError) => e.code,
	);

describe('an AI draft for a person who could approve it', () => {
	it('is addressed to them; nobody is told; others cannot see or decide it', async () => {
		const id = await fromInbox(adult.member.id);
		expect((await row(id)).for_member).toBe(adult.member.id);
		expect(await noticeRecipients()).toEqual([]);

		const list = (actor: Actor) =>
			k.route('core.listDrafts').call({ query: { sourceKind: 'inbox', limit: 50 }, actor });
		expect(await list(adult.actor)).toHaveLength(1);
		expect(await list(admin.actor)).toHaveLength(0);
		expect(await code(k.runner.approveDraft(id, admin.actor))).toBe('not_found');
		expect(await code(k.runner.rejectDraft(id, admin.actor))).toBe('not_found');

		const waiting = (actor: Actor) => k.route('core.countWaitingDrafts').call({ actor });
		expect(await waiting(adult.actor)).toEqual({ count: 1 });
		expect(await waiting(admin.actor)).toEqual({ count: 0 });

		expect((await k.runner.approveDraft(id, adult.actor)).status).toBe('applied');
	});

	it('also holds for the assistant working for them', async () => {
		const result = await k.runner.invoke(ACTION, { body: 'A' }, assistantFor(adult, 'member'));
		if (result.status !== 'drafted') throw new Error('expected a draft');
		expect((await row(result.draftId)).for_member).toBe(adult.member.id);
		expect(await noticeRecipients()).toEqual([]);
	});

	it('tells which items of a source the member may decide', async () => {
		const mine = await fromInbox(adult.member.id, 'A');
		await fromInbox(child.member.id, 'B');
		const sources = async (actor: Actor) => {
			const result = await k.runner.invoke<{ sourceIds: string[] }>(
				'core.decidableSources',
				{ sourceKind: 'inbox' },
				actor,
			);
			return result.status === 'applied' ? result.output.sourceIds.sort() : [];
		};
		expect(mine).toBeTruthy();
		// The adult's own, plus the child's (unaddressed, and an approver could decide it).
		expect(await sources(adult.actor)).toEqual(['item-A', 'item-B']);
		expect(await sources(admin.actor)).toEqual(['item-B']);
		expect(await sources(child.actor)).toEqual([]);
	});
});

describe('an AI draft for a person who could not approve it', () => {
	it('goes to the approvers, who are told, except the person behind it', async () => {
		const id = await fromInbox(child.member.id);
		expect((await row(id)).for_member).toBeNull();
		expect(await noticeRecipients()).toEqual([admin.member.id, adult.member.id].sort());
		expect((await k.runner.approveDraft(id, adult.actor)).status).toBe('applied');
	});

	it('leaves the person behind the assistant out of the notice too', async () => {
		await k.runner.invoke(ACTION, { body: 'A' }, assistantFor(child, 'supervised'));
		expect(await noticeRecipients()).toEqual([admin.member.id, adult.member.id].sort());
	});

	it('is not addressed to someone who left the family', async () => {
		await k.runner.invoke('core.archiveMember', { memberId: adult.member.id }, admin.actor);
		const id = await fromInbox(adult.member.id);
		expect((await row(id)).for_member).toBeNull();
		expect(await noticeRecipients()).toEqual([admin.member.id]);
	});
});

describe('the other rules stay', () => {
	it('auto-approval still applies first to a qualifying AI draft', async () => {
		await k.runner.invoke(
			'core.setAutoApproval',
			{ actionId: ACTION, setting: { proposerCapability: 'notes.edit' } },
			admin.actor,
		);
		const id = await fromInbox(adult.member.id);
		await k.worker.drain();
		const stored = await row(id);
		expect(stored.status).toBe('applied');
		expect(stored.auto_approved).toBe(1);
		expect(stored.for_member).toBeNull();
	});

	it('keeps a draft a member proposed for the approvers, leaving the proposer out', async () => {
		const result = await k.runner.invoke(ACTION, { body: 'Mine' }, child.actor, {
			draft: { sourceKind: 'test', sourceId: 'x' },
		});
		if (result.status !== 'drafted') throw new Error('expected a draft');
		expect((await row(result.draftId)).for_member).toBeNull();
		expect(await noticeRecipients()).toEqual([admin.member.id, adult.member.id].sort());
	});
});
