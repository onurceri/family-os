import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

// A message that an event moved arrives as a new event; the reviewer may move the one there.
const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-14', '09:00', TZ));
	admin = await k.member('admin');
});
afterEach(() => k.close());

const ai = { kind: 'ai', mode: 'share', source: 'inbox' } as const;
const add = async (input: object) => {
	const result = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, admin.actor);
	if (result.status !== 'applied') throw new Error('expected an event');
	return result.output.id;
};
const propose = async (input: object) => {
	const result = await k.runner.invoke('calendar.createEvent', input, ai);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
type Listed = {
	id: string;
	actionId: string;
	instead: { actionId: string; input: Record<string, unknown>; at?: object } | null;
};
const listed = async (id: string): Promise<Listed> =>
	(
		(await k
			.route('core.listDrafts')
			.call({ actor: admin.actor, query: { limit: 20 } })) as Listed[]
	).find((d) => d.id === id) as Listed;
const range = (from: string, to: string) =>
	k.route('calendar.listOccurrences').call({ query: { from, to } }) as Promise<
		{ eventId: string; title: string; start: number | null; startDate: string | null }[]
	>;

describe('a suggested event that is one already on the calendar', () => {
	it('offers to move the one-off event to the new day and time', async () => {
		const id = await add({ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00' });
		const draftId = await propose({
			title: 'Regional gala',
			date: '2026-11-14',
			startTime: '09:00',
			location: 'Town hall',
		});
		expect((await listed(draftId)).instead).toEqual({
			actionId: 'calendar.changeEvent',
			input: {
				id,
				label: 'Regional Gala',
				date: '2026-11-14',
				startTime: '09:00',
				location: 'Town hall',
			},
			at: { date: '2026-11-07', time: '18:00' },
		});

		await k.route('core.replaceDraft').call({ actor: admin.actor, params: { draftId } });
		expect((await k.runner.approveDraft(draftId, admin.actor)).status).toBe('applied');
		const after = await range('2026-11-01', '2026-11-30');
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			eventId: id,
			title: 'Regional Gala',
			start: epochOf('2026-11-14', '09:00', TZ),
		});

		await k.runner.undoDraft(draftId, admin.actor);
		expect((await range('2026-11-01', '2026-11-30'))[0]).toMatchObject({
			start: epochOf('2026-11-07', '18:00', TZ),
		});
	});

	it('moves only the nearest date of a repeating event', async () => {
		const id = await add({
			title: 'Swim lesson',
			date: '2026-10-03',
			startTime: '10:00',
			recurrence: { freq: 'weekly', byDay: ['SA'] },
		});
		const draftId = await propose({ title: 'Swim lesson', date: '2026-11-15', startTime: '11:00' });
		const { instead } = await listed(draftId);
		const nov14 = String(epochOf('2026-11-14', '10:00', TZ));
		expect(instead).toEqual({
			actionId: 'calendar.changeEvent',
			input: {
				id,
				label: 'Swim lesson',
				occurrence: nov14,
				date: '2026-11-15',
				startTime: '11:00',
			},
			at: { date: '2026-11-14', time: '10:00' },
		});

		await k.route('core.replaceDraft').call({ actor: admin.actor, params: { draftId } });
		expect((await k.runner.approveDraft(draftId, admin.actor)).status).toBe('applied');
		const week = await range('2026-11-09', '2026-11-22');
		expect(week.map((o) => [o.eventId === id, o.start])).toEqual([
			[false, epochOf('2026-11-15', '11:00', TZ)],
			[true, epochOf('2026-11-21', '10:00', TZ)],
		]);

		await k.runner.undoDraft(draftId, admin.actor);
		expect((await range('2026-11-09', '2026-11-22')).map((o) => o.start)).toEqual([
			epochOf('2026-11-14', '10:00', TZ),
			epochOf('2026-11-21', '10:00', TZ),
		]);
	});

	it('offers nothing for an unrelated title, the same time, a tie or a new repeating event', async () => {
		await add({ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00' });
		await add({ title: 'Dentist checkup', date: '2026-11-03', startTime: '15:00' });
		await add({ title: 'Book club', date: '2026-11-04', startTime: '19:00' });
		await add({ title: 'Book club', date: '2026-11-18', startTime: '19:00' });

		const unrelated = await propose({
			title: 'Dental cleaning',
			date: '2026-11-10',
			startTime: '15:00',
		});
		const same = await propose({ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00' });
		const tie = await propose({ title: 'Book club', date: '2026-11-11', startTime: '19:00' });
		const repeating = await propose({
			title: 'Regional Gala',
			date: '2026-11-14',
			startTime: '18:00',
			recurrence: { freq: 'weekly', byDay: ['SA'] },
		});
		for (const draftId of [unrelated, same, tie, repeating])
			expect((await listed(draftId)).instead).toBeNull();
	});

	it('changes an all-day event to a timed one when the news has a time', async () => {
		const id = await add({ title: 'School trip', date: '2026-10-20', allDay: true });
		const draftId = await propose({ title: 'school trip', date: '2026-10-22', startTime: '08:30' });
		expect((await listed(draftId)).instead).toMatchObject({
			input: { id, allDay: false, date: '2026-10-22', startTime: '08:30' },
			at: { date: '2026-10-20' },
		});
	});
});
