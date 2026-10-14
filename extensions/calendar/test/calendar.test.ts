import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
});
afterEach(() => k.close());

const range = (from: string, to: string) =>
	k.route('calendar.listOccurrences').call({ query: { from, to } });

describe('calendar', () => {
	it('stores timed events in the family time zone and lists them', async () => {
		const { actor, member } = await k.member('admin');
		const created = await k.runner.invoke<{ id: string; startTime: string }>(
			'calendar.createEvent',
			{ title: 'Kombi bakımı', date: '2026-10-06', startTime: '14:00', memberIds: [member.id] },
			actor,
		);
		expect(created.status).toBe('applied');
		const list = await range('2026-10-06', '2026-10-06');
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			title: 'Kombi bakımı',
			start: epochOf('2026-10-06', '14:00', TZ),
			end: epochOf('2026-10-06', '15:00', TZ),
			memberIds: [member.id],
			recurring: false,
		});
		expect(await range('2026-10-07', '2026-10-08')).toEqual([]);
	});

	it('changes only what is given, keeps the repeat rule and skipped dates, and changes back', async () => {
		const { actor, member } = await k.member('admin');
		const created = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{
				title: 'Yüzme',
				date: '2026-10-09',
				startTime: '18:00',
				location: 'Spor merkezi',
				recurrence: { freq: 'weekly', byDay: ['FR'] },
			},
			actor,
		);
		const id = (created as { output: { id: string } }).output.id;
		const [, second] = await range('2026-10-09', '2026-10-17');
		await k.runner.invoke('calendar.deleteEvent', { id, occurrence: second?.key }, actor);

		const changed = await k.runner.invoke<{
			event: { memberIds: string[]; location: string | null; recurrence: unknown };
			before: Record<string, unknown>;
		}>('calendar.changeEvent', { id, memberIds: [member.id], location: null }, actor);
		if (changed.status !== 'applied') throw new Error('expected applied');
		expect(changed.output.event).toMatchObject({ memberIds: [member.id], location: null });
		expect(changed.output.event.recurrence).not.toBeNull();
		expect(changed.output.before).toEqual({ memberIds: [], location: 'Spor merkezi' });
		// The skipped Friday stays skipped: only the time fields reset skipped dates.
		expect(await range('2026-10-09', '2026-10-17')).toHaveLength(1);

		await k.runner.invoke('calendar.changeEvent', { id, ...changed.output.before }, actor);
		const [back] = await range('2026-10-09', '2026-10-09');
		expect(back).toMatchObject({ memberIds: [], location: 'Spor merkezi' });
	});

	it('brings back a deleted event and a skipped date', async () => {
		const { actor } = await k.member('admin');
		const created = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{ title: 'Dişçi', date: '2026-10-09', startTime: '10:00' },
			actor,
		);
		const id = (created as { output: { id: string } }).output.id;
		await k.runner.invoke('calendar.deleteEvent', { id }, actor);
		expect(await range('2026-10-09', '2026-10-09')).toEqual([]);
		await k.runner.invoke('calendar.restoreEvent', { id }, actor);
		expect(await range('2026-10-09', '2026-10-09')).toHaveLength(1);
	});

	it('lets the AI find an event by its handle and propose a change that waits for a person', async () => {
		const { actor, member } = await k.member('admin');
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Veli toplantısı', date: '2026-10-15', startTime: '17:00' },
			actor,
		);
		const found = await k.runner.invoke<{ events: { id: string | null; occurrence: string }[] }>(
			'calendar.findEvents',
			{ from: '2026-10-15', to: '2026-10-15' },
			actor,
		);
		const id = (found as { output: { events: { id: string }[] } }).output.events[0]?.id as string;
		expect(id).toMatch(/^cal_event_/);
		const result = await k.runner.invoke(
			'calendar.changeEvent',
			{ id, startTime: '18:00', label: 'Veli toplantısı' },
			{
				kind: 'ai',
				mode: 'conversation',
				source: 'assistant',
				onBehalfOf: member.id as never,
				roleId: 'admin',
			},
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
		);
		expect(result.status).toBe('drafted');
		await k.runner.approveDraft((result as { draftId: string }).draftId, actor);
		const [event] = await range('2026-10-15', '2026-10-15');
		expect(event?.start).toBe(epochOf('2026-10-15', '18:00', TZ));
	});

	it('finds events by another form of the word searched for', async () => {
		// "When is the swimming this week?" found only "Swimming gala", not "Swim training".
		const { actor } = await k.member('admin');
		const add = (input: Record<string, unknown>) =>
			k.runner.invoke('calendar.createEvent', input, actor);
		await add({ title: 'Swim training', date: '2026-10-13', startTime: '17:00' });
		await add({ title: 'Swimming gala', date: '2026-10-17', startTime: '10:00' });
		await add({ title: 'Dentist', date: '2026-10-14', startTime: '09:00' });
		const found = await k.runner.invoke<{ events: { title: string }[] }>(
			'calendar.findEvents',
			{ from: '2026-10-12', to: '2026-10-18', text: 'swimming' },
			{ kind: 'ai', mode: 'conversation', source: 'assistant' },
		);
		if (found.status !== 'applied') throw new Error('expected applied');
		expect(found.output.events.map((e) => e.title)).toEqual(['Swim training', 'Swimming gala']);
	});

	it('tells the AI which events of the week are over, under way or ahead', async () => {
		const { actor } = await k.member('admin');
		const add = (input: Record<string, unknown>) =>
			k.runner.invoke('calendar.createEvent', input, actor);
		await add({ title: 'Monday swim', date: '2026-10-05', startTime: '17:00' });
		await add({ title: 'Saturday market', date: '2026-10-10', startTime: '09:00' });
		await add({ title: 'Saturday lunch', date: '2026-10-10', startTime: '13:00' });
		await add({ title: 'Saturday fair', date: '2026-10-10', allDay: true });
		await add({ title: 'Sunday walk', date: '2026-10-11', startTime: '10:00' });
		// Saturday 12:00 in the family's time zone.
		k.clock.set(epochOf('2026-10-10', '12:00', TZ));
		const found = await k.runner.invoke<{ events: { title: string; when?: string }[] }>(
			'calendar.findEvents',
			{ from: '2026-10-05', to: '2026-10-11' },
			{ kind: 'ai', mode: 'conversation', source: 'assistant' },
		);
		if (found.status !== 'applied') throw new Error('expected applied');
		// Only today's events say where they stand; other days are before or after by their date.
		expect(Object.fromEntries(found.output.events.map((e) => [e.title, e.when]))).toEqual({
			'Monday swim': undefined,
			'Saturday market': 'past',
			'Saturday fair': 'now',
			'Saturday lunch': 'upcoming',
			'Sunday walk': undefined,
		});
	});

	it('expands weekly events and skips a single deleted occurrence', async () => {
		const { actor } = await k.member('admin');
		const r = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{
				title: 'Yüzme',
				date: '2026-10-06',
				startTime: '17:30',
				endTime: '18:30',
				recurrence: { freq: 'weekly', byDay: ['TU'] },
			},
			actor,
		);
		if (r.status !== 'applied') throw new Error('expected applied');
		const month = await range('2026-10-01', '2026-10-31');
		expect(month.map((o: { key: string }) => o.key)).toHaveLength(4);
		const second = month[1];
		await k.runner.invoke(
			'calendar.deleteEvent',
			{ id: r.output.id, occurrence: second.key },
			actor,
		);
		const after = await range('2026-10-01', '2026-10-31');
		expect(after).toHaveLength(3);
		expect(after.some((o: { key: string }) => o.key === second.key)).toBe(false);
		const detail = await k.route('calendar.getEvent').call({ params: { eventId: r.output.id } });
		expect(detail.recurrence).toEqual({ freq: 'weekly', interval: 1, byDay: ['TU'] });
	});

	it('shows multi-day all-day events on every day they cover', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Kamp', allDay: true, date: '2026-10-09', endDate: '2026-10-11' },
			actor,
		);
		expect(await range('2026-10-10', '2026-10-10')).toEqual([
			expect.objectContaining({
				title: 'Kamp',
				allDay: true,
				startDate: '2026-10-09',
				endDate: '2026-10-11',
			}),
		]);
		expect(await range('2026-10-12', '2026-10-12')).toEqual([]);
	});

	it("turns supervised members' and AI proposals into drafts; adult members add directly", async () => {
		const { actor: supervised } = await k.member('supervised');
		const { actor: adult } = await k.member('member');
		const { actor: guest } = await k.member('guest');
		const input = { title: 'Doğum günü partisi', date: '2026-10-17', startTime: '15:00' };
		expect((await k.runner.invoke('calendar.createEvent', input, supervised)).status).toBe(
			'drafted',
		);
		await expect(k.runner.invoke('calendar.createEvent', input, guest)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect(
			(
				await k.runner.invoke('calendar.createEvent', input, {
					kind: 'ai',
					mode: 'share',
					source: 'inbox',
				})
			).status,
		).toBe('drafted');
		expect(await range('2026-10-17', '2026-10-17')).toEqual([]);
		// A couple: the other partner is a member, not an admin, and needs no approval.
		expect((await k.runner.invoke('calendar.createEvent', input, adult)).status).toBe('applied');
	});

	it('validates members and times', async () => {
		const { actor } = await k.member('admin');
		await expect(
			k.runner.invoke(
				'calendar.createEvent',
				{
					title: 'x',
					date: '2026-10-06',
					startTime: '10:00',
					memberIds: ['member_0192d3c4-0000-7000-8000-000000000000'],
				},
				actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.runner.invoke(
				'calendar.createEvent',
				{ title: 'x', date: '2026-10-06', startTime: '10:00', endTime: '10:00' },
				actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.runner.invoke('calendar.createEvent', { title: 'x', date: '2026-10-06' }, actor),
		).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	it('ends an event that runs past midnight on the next day, and keeps it so when read back', async () => {
		const { actor } = await k.member('admin');
		const created = await k.runner.invoke<{ id: string; endTime: string }>(
			'calendar.createEvent',
			{ title: 'Sleepover', date: '2026-10-09', startTime: '22:00', endTime: '07:00' },
			actor,
		);
		expect(created.status).toBe('applied');
		const [night] = await range('2026-10-09', '2026-10-09');
		expect(night).toMatchObject({
			start: epochOf('2026-10-09', '22:00', TZ),
			end: epochOf('2026-10-10', '07:00', TZ),
		});
		// It also shows on the morning it ends.
		expect(await range('2026-10-10', '2026-10-10')).toHaveLength(1);
		expect(await range('2026-10-11', '2026-10-11')).toEqual([]);
		const id = (created as { output: { id: string } }).output.id;
		const moved = await k.runner.invoke<{ event: { endTime: string } }>(
			'calendar.changeEvent',
			{ id, title: 'Sleepover at Sam’s' },
			actor,
		);
		expect(moved).toMatchObject({ output: { event: { startTime: '22:00', endTime: '07:00' } } });
		const [still] = await range('2026-10-09', '2026-10-09');
		expect(still?.end).toBe(epochOf('2026-10-10', '07:00', TZ));
	});

	it('updates and deletes events and emits changes', async () => {
		const { actor } = await k.member('admin');
		const seen: string[] = [];
		k.bus.onAny((name) => {
			seen.push(name);
		});
		const r = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{ title: 'Veli toplantısı', date: '2026-10-08', startTime: '18:30' },
			actor,
		);
		if (r.status !== 'applied') throw new Error('expected applied');
		const updated = await k.runner.invoke<{ startTime: string; title: string }>(
			'calendar.updateEvent',
			{
				id: r.output.id,
				event: { title: 'Veli toplantısı (ertelendi)', date: '2026-10-09', startTime: '19:00' },
			},
			actor,
		);
		expect(updated).toMatchObject({
			output: { title: 'Veli toplantısı (ertelendi)', startTime: '19:00', date: '2026-10-09' },
		});
		await k.runner.invoke('calendar.deleteEvent', { id: r.output.id }, actor);
		expect(await range('2026-10-01', '2026-10-31')).toEqual([]);
		expect(seen.filter((n) => n === 'calendar.event.changed')).toHaveLength(3);
	});

	it('exposes createEvent to the AI pipeline', () => {
		const entry = k.ctx.actions.aiCatalog().find((a) => a.id === 'calendar.createEvent');
		expect(entry?.description).toMatch(/family calendar/);
		expect(entry?.inputSchema).toMatchObject({
			type: 'object',
			required: expect.arrayContaining(['title', 'date']),
		});
	});
});

describe('duplicate hint', () => {
	it('marks a proposed event that already exists on that day or within a month of it', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Zoo trip', date: '2026-10-17', startTime: '09:00' },
			actor,
		);
		const ai = { kind: 'ai', mode: 'share', source: 'inbox' } as const;
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'zoo  TRIP', date: '2026-10-17', allDay: true },
			ai,
		);
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Zoo trip', date: '2026-10-18', allDay: true },
			ai,
		);
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Zoo trip', date: '2026-12-18', allDay: true },
			ai,
		);
		const drafts = await k
			.route('core.listDrafts')
			.call({ query: { status: 'pending', limit: 10 } });
		const byDate = Object.fromEntries(
			drafts.map((d: { input: { date: string }; mayExist: boolean }) => [d.input.date, d.mayExist]),
		);
		expect(byDate).toEqual({ '2026-10-17': true, '2026-10-18': true, '2026-12-18': false });
	});
});

describe('a suggested event whose day has passed', () => {
	it('expires when one-off (after its last day); a repeating one never does', async () => {
		k.clock.set(epochOf('2026-10-11', '09:00', TZ));
		const ai = { kind: 'ai', mode: 'share', source: 'inbox' } as const;
		const propose = async (input: object) => {
			const result = await k.runner.invoke('calendar.createEvent', input, ai);
			if (result.status !== 'drafted') throw new Error('expected a draft');
			return result.draftId;
		};
		const dinner = await propose({ title: 'Dinner', date: '2026-10-10', startTime: '19:00' });
		const trip = await propose({
			title: 'Trip',
			date: '2026-10-09',
			endDate: '2026-10-12',
			allDay: true,
		});
		const swimming = await propose({
			title: 'Swimming',
			date: '2026-10-09',
			startTime: '18:00',
			recurrence: { freq: 'weekly', byDay: ['FR'] },
		});

		expect(await k.runner.expirePassed()).toBe(1);
		const drafts: { id: string; status: string }[] = await k
			.route('core.listDrafts')
			.call({ query: { limit: 10 } });
		expect(Object.fromEntries(drafts.map((d) => [d.id, d.status]))).toEqual({
			[dinner]: 'expired',
			[trip]: 'pending',
			[swimming]: 'pending',
		});
	});
});
