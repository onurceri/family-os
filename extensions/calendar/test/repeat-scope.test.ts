import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

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
	date: '2026-10-20',
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

const starts = async (from: string, to: string) =>
	(await range(from, to)).map((o: { start: number }) => o.start);

describe('changing a saved repeating event from one date', () => {
	it('only this one moves that date and the series keeps its days', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		const result = await k.runner.invoke<{ id: string }>(
			'calendar.updateEvent',
			{
				id,
				occurrence: second.key,
				scope: 'this',
				event: whole({ date: '2026-10-21', recurrence: null }),
			},
			admin.actor,
		);
		expect(result.status).toBe('applied');
		expect(await starts('2026-10-13', '2026-11-03')).toEqual([
			epochOf('2026-10-13', '19:00', TZ),
			epochOf('2026-10-21', '19:00', TZ),
			epochOf('2026-10-27', '19:00', TZ),
			epochOf('2026-11-03', '19:00', TZ),
		]);
	});

	it('this one and the ones after ends the series before and starts a new one', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		const result = await k.runner.invoke<{ id: string; date: string }>(
			'calendar.updateEvent',
			{
				id,
				occurrence: second.key,
				scope: 'following',
				event: whole({
					date: '2026-10-21',
					recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
				}),
			},
			admin.actor,
		);
		if (result.status !== 'applied') throw new Error('expected applied');
		expect(result.output.id).not.toBe(id);
		expect(await starts('2026-10-13', '2026-11-04')).toEqual([
			epochOf('2026-10-13', '19:00', TZ),
			epochOf('2026-10-21', '19:00', TZ),
			epochOf('2026-10-28', '19:00', TZ),
			epochOf('2026-11-04', '19:00', TZ),
		]);
	});

	it('from the first date, the whole series changes', async () => {
		const id = await create(bins);
		const [first] = await range('2026-10-13', '2026-10-27');
		const result = await k.runner.invoke<{ id: string }>(
			'calendar.updateEvent',
			{
				id,
				occurrence: first.key,
				scope: 'following',
				event: whole({
					date: '2026-10-14',
					recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
				}),
			},
			admin.actor,
		);
		if (result.status !== 'applied') throw new Error('expected applied');
		expect(result.output.id).toBe(id);
		expect(await starts('2026-10-13', '2026-10-21')).toEqual([
			epochOf('2026-10-14', '19:00', TZ),
			epochOf('2026-10-21', '19:00', TZ),
		]);
	});

	it('a supervised member asks for the same change, which waits', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		const child = await k.member('supervised', 'Leo');
		const result = await k.runner.invoke(
			'calendar.updateEvent',
			{
				id,
				occurrence: second.key,
				scope: 'this',
				event: whole({ date: '2026-10-21', recurrence: null }),
			},
			child.actor,
		);
		expect(result.status).toBe('drafted');
		expect(await starts('2026-10-13', '2026-10-27')).toHaveLength(3);
	});
});
