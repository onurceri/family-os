import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';
import { events } from '../src/server/store.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar], translate: repoTranslate() });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-12', '09:00', TZ));
	admin = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

const range = (from: string, to: string) =>
	k.route('calendar.listOccurrences').call({ query: { from, to } });
const detail = (id: string) => k.route('calendar.getEvent').call({ params: { eventId: id } });
const row = (id: string) =>
	events(k.ctx.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirstOrThrow();

const bins = {
	title: 'Take out the bins',
	date: '2026-10-13',
	startTime: '19:00',
	endTime: '19:30',
	recurrence: { freq: 'weekly', byDay: ['TU'] },
};

async function create(input: Record<string, unknown>): Promise<string> {
	const made = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, admin.actor);
	if (made.status !== 'applied') throw new Error('expected applied');
	return made.output.id;
}

/** The form as it saves: every field, null for one left empty. */
const whole = (over: Record<string, unknown>) => ({
	title: 'Take out the bins',
	allDay: false,
	date: '2026-10-13',
	endDate: null,
	startTime: '19:00',
	endTime: '19:30',
	location: null,
	notes: null,
	memberIds: [],
	recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
	reminder: null,
	tags: null,
	...over,
});

const save = (id: string, event: Record<string, unknown>) =>
	k.runner.invoke('calendar.updateEvent', { id, event }, admin.actor);

const starts = async (from: string, to: string) =>
	(await range(from, to)).map((o: { start: number }) => o.start);

describe('saving a whole repeating event', () => {
	it('keeps a skipped date skipped when only the title changes', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: second.key }, admin.actor);
		await save(id, whole({ title: 'Bins out' }));
		expect(await starts('2026-10-13', '2026-11-03')).toEqual([
			epochOf('2026-10-13', '19:00', TZ),
			epochOf('2026-10-27', '19:00', TZ),
			epochOf('2026-11-03', '19:00', TZ),
		]);
	});

	it('does not show a date moved with "only this one" twice after the series is edited', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		await k.runner.invoke(
			'calendar.updateEvent',
			{
				id,
				occurrence: second.key,
				scope: 'this',
				event: whole({ date: '2026-10-21', recurrence: null }),
			},
			admin.actor,
		);
		await save(id, whole({ title: 'Bins out' }));
		expect(await starts('2026-10-13', '2026-10-27')).toEqual([
			epochOf('2026-10-13', '19:00', TZ),
			epochOf('2026-10-21', '19:00', TZ),
			epochOf('2026-10-27', '19:00', TZ),
		]);
	});

	it('keeps a repeat rule outside the presets through a form save', async () => {
		const id = await create(bins);
		const rule = 'FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1';
		await events(k.ctx.db)
			.updateTable('calendar_events')
			.set({ rrule: rule })
			.where('id', '=', id)
			.execute();
		const before = await detail(id);
		expect(before.recurrence).toBeNull();
		expect(before.rrule).toBe(rule);
		await save(id, whole({ title: 'Bins out', recurrence: null }));
		expect((await row(id)).rrule).toBe(rule);
		expect((await row(id)).title).toBe('Bins out');
	});

	it('keeps the own time zone of an event while its date and time stay', async () => {
		const id = await create(bins);
		const tokyo = 'Asia/Tokyo';
		await events(k.ctx.db)
			.updateTable('calendar_events')
			.set({
				time_zone: tokyo,
				starts_at: epochOf('2026-10-13', '19:00', tokyo),
				ends_at: epochOf('2026-10-13', '19:30', tokyo),
				rrule: 'FREQ=WEEKLY;BYDAY=TU',
			})
			.where('id', '=', id)
			.execute();
		const saved = await row(id);
		await save(id, whole({ title: 'Bins out' }));
		const after = await row(id);
		expect(after.time_zone).toBe(tokyo);
		expect(after.starts_at).toBe(saved.starts_at);
		await save(id, whole({ startTime: '20:00', endTime: '20:30' }));
		expect((await row(id)).time_zone).toBe(TZ);
	});

	it('drops skipped dates the new rule no longer has and keeps the moved event', async () => {
		const id = await create(bins);
		const list = await range('2026-10-13', '2026-11-03');
		await k.runner.invoke(
			'calendar.updateEvent',
			{
				id,
				occurrence: list[1].key,
				scope: 'this',
				event: whole({ date: '2026-10-21', recurrence: null }),
			},
			admin.actor,
		);
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: list[2].key }, admin.actor);
		expect(JSON.parse((await row(id)).exdates as string)).toHaveLength(2);
		await save(
			id,
			whole({ date: '2026-10-14', recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] } }),
		);
		expect((await row(id)).exdates).toBeNull();
		expect(await starts('2026-10-14', '2026-10-28')).toEqual([
			epochOf('2026-10-14', '19:00', TZ),
			epochOf('2026-10-21', '19:00', TZ),
			epochOf('2026-10-21', '19:00', TZ),
			epochOf('2026-10-28', '19:00', TZ),
		]);
	});

	it('keeps a skipped day skipped when the series only moves to another time', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: second.key }, admin.actor);
		await save(id, whole({ startTime: '20:00', endTime: '20:30' }));
		expect(await starts('2026-10-13', '2026-10-27')).toEqual([
			epochOf('2026-10-13', '20:00', TZ),
			epochOf('2026-10-27', '20:00', TZ),
		]);
	});
});
