import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

// A suggestion about an event that was deleted can never be applied: it leaves what needs a
// decision at once, and Quick add lists it as closed.
const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let child: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-14', '09:00', TZ));
	admin = await k.member('admin', 'Ayse');
	child = await k.member('supervised', 'Leo');
});
afterEach(() => k.close());

type Listed = { id: string; status: string; reason: string | null };
const listed = async (status?: string) =>
	(await k.route('core.listDrafts').call({
		actor: admin.actor,
		query: { limit: 50, ...(status && { status }) },
	})) as Listed[];
const waiting = async (actor = admin.actor) =>
	((await k.route('core.countWaitingDrafts').call({ actor })) as { count: number }).count;

const addEvent = async () => {
	const result = await k.runner.invoke<{ id: string }>(
		'calendar.createEvent',
		{ title: 'Piano lesson', date: '2026-10-20', startTime: '16:00' },
		admin.actor,
	);
	if (result.status !== 'applied') throw new Error('expected an event');
	return result.output.id;
};
const suggestDelete = async (id: string) => {
	const result = await k.runner.invoke(
		'calendar.deleteEvent',
		{ id, label: 'Piano lesson' },
		child.actor,
	);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};

describe('a suggestion whose event is gone', () => {
	it('waits while the event is there', async () => {
		const id = await addEvent();
		const draftId = await suggestDelete(id);
		expect(await waiting()).toBe(1);
		expect((await listed('pending')).map((d) => d.id)).toEqual([draftId]);
	});

	it('leaves the waiting list and the count once the event is deleted, and lists as closed', async () => {
		const id = await addEvent();
		const draftId = await suggestDelete(id);
		const other = await suggestDelete(await addEvent());
		await k.runner.invoke('calendar.deleteEvent', { id }, admin.actor);

		expect(await waiting()).toBe(1);
		expect((await listed('pending')).map((d) => d.id)).toEqual([other]);
		const closed = (await listed('expired')).find((d) => d.id === draftId);
		expect(closed).toMatchObject({ status: 'expired', reason: 'gone' });
		// The draft is kept as it was: nothing was decided.
		const all = await k.route('core.listDrafts').call({ actor: admin.actor, query: { limit: 50 } });
		expect((all as Listed[]).find((d) => d.id === draftId)?.status).toBe('expired');
	});

	it('is gone for the child who asked as well', async () => {
		const id = await addEvent();
		const draftId = await suggestDelete(id);
		await k.runner.invoke('calendar.deleteEvent', { id }, admin.actor);
		const mine = (await k.route('core.listDrafts').call({
			actor: child.actor,
			query: { limit: 50, status: 'pending' },
		})) as Listed[];
		expect(mine.map((d) => d.id)).not.toContain(draftId);
	});

	it('tells which of several drafts are gone', async () => {
		const ids = [await addEvent(), await addEvent(), await addEvent()];
		for (const id of ids) await suggestDelete(id);
		await k.runner.invoke('calendar.deleteEvent', { id: ids[1] }, admin.actor);
		const rows = (await k.ctx.db
			.withTables<{
				core_drafts: { id: string; status: string; action_id: string; input: string };
			}>()
			.selectFrom('core_drafts')
			.selectAll()
			.execute()) as never[];
		const gone = await k.runner.goneAmong(rows);
		expect(gone.size).toBe(1);
	});
});
