import { type Actor, isFamosError, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';
import { events } from '../src/server/store.ts';
import { school } from './fixtures.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: { actor: Actor; member: { id: string } };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-07', '09:00', TZ));
	admin = await k.member('admin');
});
afterEach(() => k.close());

const create = async (input: Record<string, unknown> = {}) => {
	const r = await k.runner.invoke<{ id: string }>(
		'calendar.createEvent',
		{ title: 'Event', date: '2026-10-20', startTime: '10:00', ...input },
		admin.actor,
	);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output.id;
};
const log = async () =>
	(await k.changes.since(0, admin.actor)).changes.map((c) => [c.entity, c.id, c.op]);
const row = (id: string) =>
	events(k.ctx.db)
		.selectFrom('calendar_events')
		.select(['version', 'updated_at'])
		.where('id', '=', id)
		.executeTakeFirstOrThrow();

describe('the calendar in the change log', () => {
	it('records a new event, and a removed event as a delete', async () => {
		const id = await create();
		expect(await log()).toEqual([['event', id, 'upsert']]);
		await k.runner.invoke('calendar.deleteEvent', { id }, admin.actor);
		expect(await log()).toEqual([['event', id, 'delete']]);
	});

	it('records skipping one date of a series as a change of the series, not a delete', async () => {
		const id = await create({ recurrence: { freq: 'weekly', byDay: ['TU'] } });
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: '2026-10-27' }, admin.actor);
		expect(await log()).toEqual([['event', id, 'upsert']]);
	});

	it('counts a tag rename on the events it rewrote, which leave updated_at alone', async () => {
		const id = await create({ tags: ['School'] });
		const other = await create({ title: 'Other', tags: ['Swim'] });
		const before = await row(id);
		expect(before.version).toBe(0);
		const seen = (await k.changes.head()) as number;
		await k.runner.invoke('calendar.updateTag', { name: 'School', newName: 'Class' }, admin.actor);
		const after = await row(id);
		expect(after.version).toBe(1);
		expect(after.updated_at).toBe(before.updated_at);
		expect((await row(other)).version).toBe(0);
		// A reader learns that the events changed, and only the ones that did.
		const page = await k.changes.since(seen, admin.actor);
		expect(page.changes.map((c) => [c.id, c.op])).toEqual([[id, 'upsert']]);
	});

	it('refuses a write made on a version that has moved on', async () => {
		const id = await create({ tags: ['School'] });
		await k.runner.invoke('calendar.updateTag', { name: 'School', newName: 'Class' }, admin.actor);
		const error = await k.runner
			.invoke('calendar.deleteEvent', { id }, admin.actor, { ifMatch: 0 })
			.catch((e: unknown) => e);
		expect(isFamosError(error) && error.code).toBe('precondition_failed');
		expect(
			(await events(k.ctx.db).selectFrom('calendar_events').select('deleted_at').execute())[0],
		).toEqual({
			deleted_at: null,
		});
		const done = await k.runner.invoke('calendar.deleteEvent', { id }, admin.actor, { ifMatch: 1 });
		expect(done.status).toBe('applied');
	});

	it('records a subscription the refresh job changed, with the data in one transaction', async () => {
		k.http.serve('https://school.example/cal.ics', { text: school });
		const added = await k.runner.invoke<{ id: string }>(
			'calendar.addSubscription',
			{ name: 'School', url: 'https://school.example/cal.ics' },
			admin.actor,
		);
		if (added.status !== 'applied') throw new Error('expected applied');
		const seen = await k.changes.head();
		await k.worker.drain();
		const page = await k.changes.since(seen, admin.actor);
		expect(page.changes.map((c) => [c.entity, c.id, c.op])).toEqual([
			['subscription', added.output.id, 'upsert'],
		]);
		await k.runner.invoke('calendar.removeSubscription', { id: added.output.id }, admin.actor);
		expect((await log()).at(-1)).toEqual(['subscription', added.output.id, 'delete']);
	});
});
