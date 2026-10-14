import type { Actor, FamosError, MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notesExtension] });
	admin = await k.member('admin');
});
afterEach(() => k.close());

const db = () => k.ctx.db.withTables<CoreTables>();
const ACTION = 'notes.addNote';
const enable = (capability: string, actor: Actor = admin.actor) =>
	k.runner.invoke(
		'core.setAutoApproval',
		{ actionId: ACTION, setting: { proposerCapability: capability } },
		actor,
	);
const noteCount = async () => {
	const result = await k.runner.invoke<{ count: number }>('notes.countNotes', {}, admin.actor);
	if (result.status !== 'applied') throw new Error('expected a count');
	return result.output.count;
};
const draft = (id: string) =>
	db().selectFrom('core_drafts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const propose = async (actor: Actor, body = 'Milk') => {
	const result = await k.runner.invoke(ACTION, { body }, actor, {
		draft: { sourceKind: 'test', sourceId: body },
	});
	if (result.status !== 'drafted') throw new Error('expected a draft');
	await k.worker.drain();
	return result.draftId;
};
const waitingNotices = async () => {
	k.clock.advance(60_000);
	await k.worker.drain();
	return db()
		.selectFrom('core_notifications')
		.selectAll()
		.where('kind', '=', 'core.draftWaiting')
		.execute();
};
const stopped = () =>
	db()
		.selectFrom('core_notifications')
		.selectAll()
		.where('kind', '=', 'core.autoApprovalStopped')
		.execute();
const assistantFor = (memberId: string, roleId: string): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: memberId as MemberId,
	roleId,
});

describe('the setting', () => {
	it('is managed with core.autoApprove.manage only, and only for actions that opted in', async () => {
		const adult = await k.member('member');
		const error = await enable('core.memory.use', adult.actor).catch((e: unknown) => e);
		expect((error as FamosError).code).toBe('forbidden');

		const bad = (input: object) =>
			k.runner.invoke('core.setAutoApproval', input, admin.actor).catch((e: unknown) => e);
		expect(((await bad({ actionId: 'notes.purge', setting: null })) as FamosError).code).toBe(
			'bad_request',
		);
		expect(((await bad({ actionId: 'core.createMember', setting: null })) as FamosError).code).toBe(
			'bad_request',
		);
		// A capability that is not one of the action's choices.
		expect(
			(
				(await bad({
					actionId: ACTION,
					setting: { proposerCapability: 'notes.purge' },
				})) as FamosError
			).code,
		).toBe('bad_request');
	});

	it('is listed with the choices of each action and who turned it on', async () => {
		const route = k.route('core.listAutoApproval');
		let listed = await route.call();
		expect(listed.actions).toEqual([
			{
				actionId: ACTION,
				labelKey: 'notes:auto_approve',
				choices: [
					{ value: 'notes.edit', labelKey: 'notes:cap_edit' },
					{ value: 'core.memory.use', labelKey: 'app:cap_memory_use' },
				],
				setting: null,
			},
		]);
		await enable('core.memory.use');
		listed = await route.call();
		expect(listed.actions[0].setting).toMatchObject({
			proposerCapability: 'core.memory.use',
			enabledBy: admin.member.id,
			enabledByName: admin.member.displayName,
		});
		await k.runner.invoke('core.setAutoApproval', { actionId: ACTION, setting: null }, admin.actor);
		expect((await route.call()).actions[0].setting).toBeNull();
	});
});

describe('auto-approval of drafts', () => {
	it('approves, as the person who turned it on, what the AI suggests for someone who holds the capability', async () => {
		await enable('core.memory.use');
		const child = await k.member('supervised');
		const id = await propose(assistantFor(child.member.id, 'supervised'));
		const row = await draft(id);
		expect(row.status).toBe('applied');
		expect(row.auto_approved).toBe(1);
		expect(row.decided_by).toBe(admin.member.id);
		expect(await noteCount()).toBe(1);
		// Nobody is told it waits: it did not.
		expect(await waitingNotices()).toEqual([]);
	});

	it('leaves what the AI suggests for someone who does not hold it, and tells the approvers', async () => {
		await enable('notes.edit');
		const child = await k.member('supervised');
		const id = await propose(assistantFor(child.member.id, 'supervised'));
		expect((await draft(id)).status).toBe('pending');
		expect((await draft(id)).auto_approved).toBe(0);
		expect(await noteCount()).toBe(0);
		expect((await waitingNotices()).map((n) => n.member_id)).toEqual([admin.member.id]);
	});

	it('leaves drafts alone when no setting exists, and after it is turned off', async () => {
		const child = await k.member('supervised');
		expect(
			(await draft(await propose(assistantFor(child.member.id, 'supervised'), 'A'))).status,
		).toBe('pending');
		await enable('core.memory.use');
		await k.runner.invoke('core.setAutoApproval', { actionId: ACTION, setting: null }, admin.actor);
		expect(
			(await draft(await propose(assistantFor(child.member.id, 'supervised'), 'B'))).status,
		).toBe('pending');
	});

	it('approves what the assistant or the Inbox suggests for a person who qualifies', async () => {
		const adult = await k.member('member');
		await enable('notes.edit');
		const viaAssistant = await propose(assistantFor(adult.member.id, 'member'), 'B');
		expect((await draft(viaAssistant)).status).toBe('applied');
		expect((await draft(viaAssistant)).auto_approved).toBe(1);

		// The Inbox names the person it read the message from.
		const inbox = await k.runner.invoke(
			ACTION,
			{ body: 'C' },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
			{ draft: { sourceKind: 'inbox', sourceId: 'i1', forMember: adult.member.id } },
		);
		await k.worker.drain();
		expect(inbox.status === 'drafted' && (await draft(inbox.draftId)).status).toBe('applied');
	});

	it('never approves a draft a person made themselves, even if they hold the capability', async () => {
		await enable('core.memory.use');
		const child = await k.member('supervised');
		const id = await propose(child.actor, 'Mine');
		expect((await draft(id)).status).toBe('pending');
		expect((await draft(id)).auto_approved).toBe(0);
		expect(await noteCount()).toBe(0);
	});

	it('never approves what the AI proposes for someone who does not qualify, or for nobody', async () => {
		const child = await k.member('supervised');
		await enable('notes.edit');
		const forChild = await propose(assistantFor(child.member.id, 'supervised'), 'A');
		expect((await draft(forChild)).status).toBe('pending');
		const forNobody = await k.runner.invoke(
			ACTION,
			{ body: 'B' },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		await k.worker.drain();
		expect(forNobody.status === 'drafted' && (await draft(forNobody.draftId)).status).toBe(
			'pending',
		);
	});

	it('can be undone like any approval', async () => {
		await enable('core.memory.use');
		const child = await k.member('supervised');
		const id = await propose(assistantFor(child.member.id, 'supervised'));
		expect(await noteCount()).toBe(1);
		await k.runner.undoDraft(id, admin.actor);
		expect((await draft(id)).status).toBe('undone');
		expect(await noteCount()).toBe(0);
	});

	it('does nothing the second time the job runs', async () => {
		await enable('core.memory.use');
		const child = await k.member('supervised');
		const id = await propose(assistantFor(child.member.id, 'supervised'));
		await k.ctx.enqueue(
			'core.autoApprove',
			{ draftId: id, proposerMemberId: child.member.id },
			{ dedupeKey: 'again' },
		);
		await k.worker.drain();
		expect(await noteCount()).toBe(1);
		const audit = await db()
			.selectFrom('core_audit_log')
			.selectAll()
			.where('draft_id', '=', id)
			.where('outcome', '=', 'applied')
			.execute();
		expect(audit).toHaveLength(1);
	});

	it('leaves a draft a person decided first', async () => {
		await enable('core.memory.use');
		const child = await k.member('supervised');
		const result = await k.runner.invoke(
			ACTION,
			{ body: 'X' },
			assistantFor(child.member.id, 'supervised'),
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		// Rejected before the worker runs the job.
		await k.runner.rejectDraft(result.draftId, admin.actor);
		await k.worker.drain();
		expect((await draft(result.draftId)).status).toBe('rejected');
		expect(await noteCount()).toBe(0);
	});
});

describe('when the person who turned it on can no longer approve', () => {
	it('stops and tells them if they lost the capability', async () => {
		const other = await k.member('admin');
		await enable('core.memory.use');
		await k.runner.invoke(
			'core.updateMember',
			{ memberId: admin.member.id, roleId: 'member' },
			other.actor,
		);
		const child = await k.member('supervised');
		const id = await propose(assistantFor(child.member.id, 'supervised'));

		expect((await draft(id)).status).toBe('pending');
		expect(await noteCount()).toBe(0);
		expect((await k.route('core.listAutoApproval').call()).actions[0].setting).toBeNull();
		expect((await stopped()).map((n) => n.member_id)).toEqual([admin.member.id]);
		// The suggestion is announced to approvers after all.
		expect((await waitingNotices()).length).toBeGreaterThan(0);
	});

	it('stops and tells the other managers if they are gone', async () => {
		const other = await k.member('admin');
		await enable('core.memory.use');
		await k.runner.invoke('core.archiveMember', { memberId: admin.member.id }, other.actor);
		const child = await k.member('supervised');
		const id = await propose(assistantFor(child.member.id, 'supervised'));

		expect((await draft(id)).status).toBe('pending');
		expect((await k.route('core.listAutoApproval').call()).actions[0].setting).toBeNull();
		expect((await stopped()).map((n) => n.member_id)).toEqual([other.member.id]);
	});

	it('does not touch a newer setting someone made meanwhile', async () => {
		const other = await k.member('admin');
		await enable('core.memory.use');
		await k.runner.invoke('core.archiveMember', { memberId: admin.member.id }, other.actor);
		k.clock.advance(1000);
		await enable('core.memory.use', other.actor);
		const child = await k.member('supervised');
		const id = await propose(assistantFor(child.member.id, 'supervised'));
		// The newer setting, made by a manager who is here, approves it.
		expect((await draft(id)).status).toBe('applied');
		expect((await draft(id)).decided_by).toBe(other.member.id);
	});
});

describe('the delay before a suggestion notifies', () => {
	const notified = async () => {
		await k.worker.drain();
		return (
			await db()
				.selectFrom('core_notifications')
				.selectAll()
				.where('kind', '=', 'core.draftWaiting')
				.execute()
		).length;
	};
	const proposeWith = async (draftNotifyDelayMs?: number) => {
		await k.close();
		k = await createTestKernel({
			extensions: [notesExtension],
			...(draftNotifyDelayMs !== undefined && { draftNotifyDelayMs }),
		});
		admin = await k.member('admin');
		const child = await k.member('supervised');
		await k.runner.invoke(ACTION, { body: 'Milk' }, child.actor, {
			draft: { sourceKind: 'test', sourceId: 'Milk' },
		});
	};

	it('is 30 seconds unless the kernel is told otherwise', async () => {
		await proposeWith();
		k.clock.advance(5_000);
		expect(await notified()).toBe(0);
		k.clock.advance(25_000);
		expect(await notified()).toBe(1);
	});

	it('follows the kernel option', async () => {
		await proposeWith(500);
		expect(await notified()).toBe(0);
		k.clock.advance(500);
		expect(await notified()).toBe(1);
	});
});
