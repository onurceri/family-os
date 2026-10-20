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
const starts = async (from: string, to: string) =>
	(await range(from, to)).map((o: { start: number }) => o.start);

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

const change = (id: string, patch: Record<string, unknown>) =>
	k.runner.invoke('calendar.changeEvent', { id, ...patch }, admin.actor);

describe('changing a repeating event with a patch', () => {
	it('keeps a deleted date deleted when date and time are sent unchanged', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: second.key }, admin.actor);
		await change(id, {
			title: 'Bins out',
			date: '2026-10-13',
			startTime: '19:00',
			endTime: '19:30',
			allDay: false,
		});
		expect(await starts('2026-10-13', '2026-11-03')).toEqual([
			epochOf('2026-10-13', '19:00', TZ),
			epochOf('2026-10-27', '19:00', TZ),
			epochOf('2026-11-03', '19:00', TZ),
		]);
	});

	it('does not show a date moved with "only this one" twice', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		await k.runner.invoke(
			'calendar.changeEvent',
			{ id, occurrence: second.key, date: '2026-10-21' },
			admin.actor,
		);
		const shown = await starts('2026-10-13', '2026-10-27');
		await change(id, { date: '2026-10-13', startTime: '19:00' });
		expect(await starts('2026-10-13', '2026-10-27')).toEqual(shown);
		expect(shown.filter((s: number) => s === epochOf('2026-10-21', '19:00', TZ))).toHaveLength(1);
	});

	it('moves a skipped date with a real time change', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: second.key }, admin.actor);
		await change(id, { startTime: '18:00' });
		expect(await starts('2026-10-13', '2026-11-03')).toEqual([
			epochOf('2026-10-13', '18:00', TZ),
			epochOf('2026-10-27', '18:00', TZ),
			epochOf('2026-11-03', '18:00', TZ),
		]);
	});

	it('keeps a skipped date when the series start moves onto it', async () => {
		const id = await create(bins);
		const [, second] = await range('2026-10-13', '2026-10-27');
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: second.key }, admin.actor);
		await change(id, { date: '2026-10-20' });
		expect(await starts('2026-10-20', '2026-11-03')).toEqual([
			epochOf('2026-10-27', '19:00', TZ),
			epochOf('2026-11-03', '19:00', TZ),
		]);
	});
});

describe('the repeat rule of an event', () => {
	it('is returned with the event, also when it is a plain preset', async () => {
		const id = await create(bins);
		const event = await k.route('calendar.getEvent').call({ params: { eventId: id } });
		expect(event.recurrence).toEqual(expect.objectContaining({ freq: 'weekly' }));
		expect(event.rrule).toBe('FREQ=WEEKLY;BYDAY=TU');
	});

	it('is null for a one-off event', async () => {
		const id = await create({ title: 'Dentist', date: '2026-10-14', startTime: '10:00' });
		const event = await k.route('calendar.getEvent').call({ params: { eventId: id } });
		expect(event.rrule).toBeNull();
	});
});
