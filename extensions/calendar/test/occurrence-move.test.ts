import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-12', '09:00', TZ)); // a Monday
	admin = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

const range = (from: string, to: string) =>
	k.route('calendar.listOccurrences').call({ query: { from, to } });

async function create(input: Record<string, unknown>): Promise<string> {
	const made = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, admin.actor);
	if (made.status !== 'applied') throw new Error('expected applied');
	return made.output.id;
}

const ai = () =>
	({
		kind: 'ai',
		source: 'assistant',
		onBehalfOf: admin.member.id as never,
		roleId: 'admin',
	}) as const;

describe('moving one date of a repeating event', () => {
	it('splits that date out as its own event and skips it in the series', async () => {
		// "Move Sunday planning to 18:00" made a second "Sunday planning" instead of moving it.
		const id = await create({
			title: 'Sunday planning',
			date: '2026-10-11',
			startTime: '20:00',
			endTime: '21:00',
			location: 'Kitchen',
			recurrence: { freq: 'weekly', byDay: ['SU'] },
		});
		const [, next] = await range('2026-10-11', '2026-10-25');
		expect(next).toMatchObject({ start: epochOf('2026-10-18', '20:00', TZ) });

		const moved = await k.runner.invoke<{
			event: { id: string; date: string; startTime: string; endTime: string; recurrence: unknown };
			split: { seriesId: string; occurrence: string };
		}>(
			'calendar.changeEvent',
			{ id, occurrence: next.key, startTime: '18:00', label: 'Sunday planning' },
			admin.actor,
		);
		if (moved.status !== 'applied') throw new Error('expected applied');
		expect(moved.output.event).toMatchObject({
			date: '2026-10-18',
			startTime: '18:00',
			endTime: '19:00',
			recurrence: null,
		});
		expect(moved.output.split).toEqual({ seriesId: id, occurrence: next.key });
		expect(moved.output.event.id).not.toBe(id);

		const week = await range('2026-10-11', '2026-10-25');
		expect(week.map((o: { start: number }) => o.start)).toEqual([
			epochOf('2026-10-11', '20:00', TZ),
			epochOf('2026-10-18', '18:00', TZ),
			epochOf('2026-10-25', '20:00', TZ),
		]);
		// The moved date keeps the series' other details.
		expect(week[1]).toMatchObject({
			title: 'Sunday planning',
			location: 'Kitchen',
			recurring: false,
		});
		expect(week[0]).toMatchObject({ recurring: true });
	});

	it('moves an all-day date to another day and keeps the length of a multi-day event', async () => {
		const id = await create({
			title: 'Camp',
			allDay: true,
			date: '2026-10-12',
			endDate: '2026-10-13',
			recurrence: { freq: 'weekly', byDay: ['MO'] },
		});
		const moved = await k.runner.invoke<{ event: { date: string; endDate: string | null } }>(
			'calendar.changeEvent',
			{ id, occurrence: '2026-10-19', date: '2026-10-21' },
			admin.actor,
		);
		if (moved.status !== 'applied') throw new Error('expected applied');
		expect(moved.output.event).toMatchObject({ date: '2026-10-21', endDate: '2026-10-22' });
		const days = await range('2026-10-12', '2026-10-26');
		expect(days.map((o: { startDate: string }) => o.startDate)).toEqual([
			'2026-10-12',
			'2026-10-21',
			'2026-10-26',
		]);
	});

	it('refuses a date the series does not have', async () => {
		const id = await create({
			title: 'Sunday planning',
			date: '2026-10-11',
			startTime: '20:00',
			recurrence: { freq: 'weekly', byDay: ['SU'] },
		});
		await expect(
			k.runner.invoke(
				'calendar.changeEvent',
				{ id, occurrence: String(epochOf('2026-10-14', '20:00', TZ)), startTime: '18:00' },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.runner.invoke(
				'calendar.changeEvent',
				{ id, occurrence: 'soon', startTime: '18:00' },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('is a suggestion for the AI, and approving then undoing puts the date back', async () => {
		const id = await create({
			title: 'Sunday planning',
			date: '2026-10-11',
			startTime: '20:00',
			recurrence: { freq: 'weekly', byDay: ['SU'] },
		});
		const [, next] = await range('2026-10-11', '2026-10-25');
		const result = await k.runner.invoke(
			'calendar.changeEvent',
			{ id, occurrence: next.key, startTime: '18:00', label: 'Sunday planning' },
			ai(),
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		expect(await range('2026-10-18', '2026-10-18')).toMatchObject([{ recurring: true }]);

		await k.runner.approveDraft(result.draftId, admin.actor);
		expect(await range('2026-10-18', '2026-10-18')).toMatchObject([
			{ start: epochOf('2026-10-18', '18:00', TZ), recurring: false },
		]);

		await k.runner.undoDraft(result.draftId, admin.actor);
		const back = await range('2026-10-18', '2026-10-18');
		expect(back).toHaveLength(1);
		expect(back[0]).toMatchObject({ start: epochOf('2026-10-18', '20:00', TZ), recurring: true });
	});
});

describe('naming one date of a repeating event by its day', () => {
	const piano = () =>
		create({
			title: 'Piano lesson',
			date: '2026-10-08',
			startTime: '16:00',
			endTime: '16:45',
			recurrence: { freq: 'weekly', byDay: ['TH'] },
		});

	it('moves the occurrence of that day when the model sends a date (the real mistake)', async () => {
		// The model sent "2026-10-15" for a timed series; it used to fail only when approved.
		const id = await piano();
		const result = await k.runner.invoke(
			'calendar.changeEvent',
			{ id, occurrence: '2026-10-15', startTime: '17:00', label: 'Piano lesson' },
			ai(),
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect(await range('2026-10-15', '2026-10-15')).toMatchObject([
			{ start: epochOf('2026-10-15', '17:00', TZ), recurring: false },
		]);
		expect(await range('2026-10-08', '2026-10-08')).toMatchObject([{ recurring: true }]);
	});

	it('stores the key, so the draft says which occurrence it is', async () => {
		const id = await piano();
		const result = await k.runner.invoke(
			'calendar.deleteEvent',
			{ id, occurrence: '2026-10-15', label: 'Piano lesson' },
			ai(),
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_2' } },
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		const [draft] = await k
			.route('core.listDrafts')
			.call({ actor: admin.actor, query: { status: 'pending', limit: 5 } });
		expect(draft.input.occurrence).toBe(String(epochOf('2026-10-15', '16:00', TZ)));
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect(await range('2026-10-15', '2026-10-15')).toEqual([]);
	});

	it('refuses a day the series does not have to the model, with nothing drafted', async () => {
		const id = await piano();
		await expect(
			k.runner.invoke(
				'calendar.changeEvent',
				{ id, occurrence: '2026-10-14', startTime: '17:00', label: 'Piano lesson' },
				ai(),
				{ draft: { sourceKind: 'assistant', sourceId: 'turn_3' } },
			),
		).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('does not happen on 2026-10-14'),
		});
		await expect(
			k.runner.invoke(
				'calendar.deleteEvent',
				{ id, occurrence: 'soon', label: 'Piano lesson' },
				ai(),
				{ draft: { sourceKind: 'assistant', sourceId: 'turn_3' } },
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(
			await k
				.route('core.listDrafts')
				.call({ actor: admin.actor, query: { status: 'pending', limit: 5 } }),
		).toEqual([]);
	});
});

describe('finding an event by its text', () => {
	const find = (input: Record<string, unknown>) =>
		k.runner.invoke<{ events: { title: string; date: string }[]; note?: string }>(
			'calendar.findEvents',
			input,
			{ kind: 'ai', source: 'assistant' },
		);

	it('searches from today for two months when only text is given', async () => {
		await create({ title: 'Delft project call', date: '2026-11-20', startTime: '10:00' });
		await create({ title: 'Delft old call', date: '2026-10-01', startTime: '10:00' });
		const found = await find({ text: 'delft' });
		if (found.status !== 'applied') throw new Error('expected applied');
		expect(found.output.events.map((e) => e.title)).toEqual(['Delft project call']);
	});

	it('still needs a range when there is no text', async () => {
		await expect(find({})).rejects.toMatchObject({ code: 'bad_request' });
		await expect(find({ to: '2026-10-12' })).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('names the keys it received when it cannot search', async () => {
		await expect(find({ to: '2026-10-12', members: [] })).rejects.toMatchObject({
			message: expect.stringContaining('Received: to, members'),
		});
	});

	it('takes `from` alone as that one day', async () => {
		await create({ title: 'Monday swim', date: '2026-10-12', startTime: '17:00' });
		await create({ title: 'Tuesday swim', date: '2026-10-13', startTime: '17:00' });
		const found = await find({ from: '2026-10-12' });
		if (found.status !== 'applied') throw new Error('expected applied');
		expect(found.output.events.map((e) => e.title)).toEqual(['Monday swim']);
	});

	it('gives the next match as a record the model can use', async () => {
		const lukas = await k.member('member', 'Lukas');
		const noah = await k.member('member', 'Noah');
		await create({
			title: 'Swimming',
			date: '2026-10-13',
			startTime: '17:00',
			memberIds: [noah.member.id],
		});
		const gala = await create({
			title: 'Swimming gala',
			date: '2026-11-07',
			startTime: '10:00',
			memberIds: [lukas.member.id],
		});
		const found = await find({
			from: '2026-10-12',
			to: '2026-10-18',
			text: 'swimming',
			members: [lukas.member.id],
		});
		if (found.status !== 'applied') throw new Error('expected applied');
		expect(found.output.events).toEqual([]);
		expect(found.output).toMatchObject({
			nextMatch: { id: gala, title: 'Swimming gala', date: '2026-11-07' },
		});
	});

	it('names the next match when the searched range has none', async () => {
		await create({ title: 'Dentist checkup', date: '2026-12-03', startTime: '09:00' });
		const found = await find({ from: '2026-10-12', to: '2026-10-17', text: 'dentist' });
		if (found.status !== 'applied') throw new Error('expected applied');
		expect(found.output.events).toEqual([]);
		expect(found.output.note).toContain('The next match is "Dentist checkup" on 2026-12-03');
		const none = await find({ from: '2026-10-12', to: '2026-10-17', text: 'sailing' });
		if (none.status !== 'applied') throw new Error('expected applied');
		expect(none.output.note).toBeUndefined();
	});
});
