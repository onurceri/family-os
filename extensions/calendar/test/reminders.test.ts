import { type Actor, systemActor } from '@famos/sdk';
import { createFakeChannel, createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';
import { events } from '../src/server/store.ts';
import { wholeEvent } from './whole-event.ts';

const TZ = 'Europe/Istanbul';
const MIN = 60_000;
let k: TestKernel;
let channel: ReturnType<typeof createFakeChannel>;

beforeEach(async () => {
	channel = createFakeChannel('web');
	k = await createTestKernel({
		extensions: [calendar],
		channels: [channel],
		// Shows the language and the parameters a text was rendered with.
		translate: (locale, key, params) => `${locale}|${key}|${JSON.stringify(params ?? {})}`,
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, formatLocale: 'en-GB', hourCycle: 'h23' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-05', '10:00', TZ));
});
afterEach(() => k.close());

const at = (date: string, time: string, tz = TZ) => epochOf(date, time, tz);

/** A member with a language of their own. */
async function person(roleId: string, locale: 'en' | 'tr') {
	const result = await k.runner.invoke<{ id: string }>(
		'core.createMember',
		{ displayName: `${roleId} ${locale}`, roleId, locale },
		systemActor('test'),
	);
	if (result.status !== 'applied') throw new Error('expected member');
	const actor: Actor = { kind: 'member', memberId: result.output.id as never, roleId };
	return { id: result.output.id, actor };
}

async function create(input: Record<string, unknown>, actor: Actor) {
	const r = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, actor);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output.id;
}

/** Moves the clock to `ms` and runs everything that is due. */
async function advanceTo(ms: number) {
	k.clock.set(ms);
	await k.worker.drain();
}
const recipients = () => channel.sent.map((s) => s.memberId).sort();

describe('timed events', () => {
	it('reminds the event members 30 minutes before by default, in their language', async () => {
		const ann = await person('admin', 'en');
		const can = await person('member', 'tr');
		await person('member', 'en'); // not involved
		await create(
			{
				title: 'Zoo trip',
				date: '2026-10-10',
				startTime: '14:00',
				location: 'Zoo',
				memberIds: [ann.id, can.id],
			},
			ann.actor,
		);
		await advanceTo(at('2026-10-10', '13:30') - 1);
		expect(channel.sent).toHaveLength(0);
		await advanceTo(at('2026-10-10', '13:30'));
		expect(recipients()).toEqual([ann.id, can.id].sort());
		const byMember = Object.fromEntries(channel.sent.map((s) => [s.memberId, s.message]));
		expect(byMember[ann.id]).toMatchObject({
			title: 'en|calendar:reminder_title|{"title":"Zoo trip"}',
			body: 'en|calendar:reminder_timed_where|{"time":"14:00","location":"Zoo"}',
			url: '/calendar',
		});
		expect(byMember[can.id]?.title.startsWith('tr|')).toBe(true);
		await advanceTo(at('2026-10-11', '10:00'));
		expect(channel.sent).toHaveLength(2);
	});

	it('uses the chosen lead time', async () => {
		const ann = await person('admin', 'en');
		await create(
			{
				title: 'Dentist',
				date: '2026-10-10',
				startTime: '14:00',
				memberIds: [ann.id],
				reminder: 1440,
			},
			ann.actor,
		);
		await advanceTo(at('2026-10-09', '14:00'));
		expect(channel.sent).toHaveLength(1);
	});

	it('moves the reminder when the start changes: the old job does nothing', async () => {
		const ann = await person('admin', 'en');
		const id = await create(
			{ title: 'Meeting', date: '2026-10-10', startTime: '14:00', memberIds: [ann.id] },
			ann.actor,
		);
		await k.runner.invoke(
			'calendar.updateEvent',
			{
				id,
				event: wholeEvent({
					title: 'Meeting',
					date: '2026-10-10',
					startTime: '16:00',
					memberIds: [ann.id],
				}),
			},
			ann.actor,
		);
		await advanceTo(at('2026-10-10', '13:30'));
		expect(channel.sent).toHaveLength(0);
		await advanceTo(at('2026-10-10', '15:30'));
		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]?.message.body).toContain('"time":"16:00"');
	});

	it('moves the reminder even when the clock did not move between create and update', async () => {
		const ann = await person('admin', 'en');
		const id = await create(
			{ title: 'Meeting', date: '2026-10-10', startTime: '14:00', memberIds: [ann.id] },
			ann.actor,
		);
		const before = await events(k.ctx.db)
			.selectFrom('calendar_events')
			.select('updated_at')
			.executeTakeFirstOrThrow();
		await k.runner.invoke(
			'calendar.updateEvent',
			{
				id,
				event: wholeEvent({
					title: 'Meeting',
					date: '2026-10-10',
					startTime: '14:00',
					memberIds: [ann.id],
					reminder: 60,
				}),
			},
			ann.actor,
		);
		expect(before.updated_at).toBe(k.clock.now());
		await advanceTo(at('2026-10-10', '13:00') - 1);
		expect(channel.sent).toHaveLength(0);
		await advanceTo(at('2026-10-10', '13:00'));
		expect(channel.sent).toHaveLength(1);
		await advanceTo(at('2026-10-10', '13:30'));
		expect(channel.sent).toHaveLength(1);
	});

	it('sends nothing after the event is deleted', async () => {
		const ann = await person('admin', 'en');
		const id = await create(
			{ title: 'Meeting', date: '2026-10-10', startTime: '14:00', memberIds: [ann.id] },
			ann.actor,
		);
		await k.runner.invoke('calendar.deleteEvent', { id }, ann.actor);
		await advanceTo(at('2026-10-10', '13:45'));
		expect(channel.sent).toHaveLength(0);
	});

	it('sends nothing when the reminder is explicitly none', async () => {
		const ann = await person('admin', 'en');
		const id = await create(
			{
				title: 'Quiet',
				date: '2026-10-10',
				startTime: '14:00',
				memberIds: [ann.id],
				reminder: null,
			},
			ann.actor,
		);
		await advanceTo(at('2026-10-10', '13:45'));
		expect(channel.sent).toHaveLength(0);
		const detail = await k.route('calendar.getEvent').call({ params: { eventId: id } });
		expect(detail.reminder).toBeNull();
	});

	it('reports the default in the detail and refuses presets that do not exist', async () => {
		const ann = await person('admin', 'en');
		const id = await create({ title: 'A', date: '2026-10-10', startTime: '14:00' }, ann.actor);
		const timed = await k.route('calendar.getEvent').call({ params: { eventId: id } });
		expect(timed.reminder).toBe(30);
		const allDay = await create({ title: 'B', date: '2026-10-10', allDay: true }, ann.actor);
		expect(
			(await k.route('calendar.getEvent').call({ params: { eventId: allDay } })).reminder,
		).toBe(0);
		await expect(
			k.runner.invoke(
				'calendar.createEvent',
				{ title: 'C', date: '2026-10-10', startTime: '14:00', reminder: 7 },
				ann.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.runner.invoke(
				'calendar.createEvent',
				{ title: 'D', date: '2026-10-10', allDay: true, reminder: 30 },
				ann.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('treats rows from before reminders as "default"', async () => {
		const ann = await person('admin', 'en');
		const id = await create(
			{ title: 'Old', date: '2026-10-10', startTime: '14:00', memberIds: [ann.id] },
			ann.actor,
		);
		await events(k.ctx.db)
			.updateTable('calendar_events')
			.set({ reminder_set: 0, reminder_minutes: null })
			.where('id', '=', id)
			.execute();
		expect((await k.route('calendar.getEvent').call({ params: { eventId: id } })).reminder).toBe(
			30,
		);
	});

	it('does not send a reminder that is already long past when the event is created', async () => {
		const ann = await person('admin', 'en');
		await create(
			{ title: 'Soon', date: '2026-10-05', startTime: '10:10', memberIds: [ann.id] },
			ann.actor,
		);
		await advanceTo(at('2026-10-05', '10:30'));
		expect(channel.sent).toHaveLength(0);
	});

	it('does not notify twice when the job runs again', async () => {
		const ann = await person('admin', 'en');
		const id = await create(
			{ title: 'Meeting', date: '2026-10-10', startTime: '14:00', memberIds: [ann.id] },
			ann.actor,
		);
		const row = await events(k.ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirstOrThrow();
		const start = at('2026-10-10', '14:00');
		const payload = {
			eventId: id,
			key: String(start),
			at: start - 30 * MIN,
			version: row.updated_at,
		};
		await k.queue.enqueue(k.ctx.db, 'calendar.remind', payload);
		await advanceTo(at('2026-10-10', '13:30'));
		expect(channel.sent).toHaveLength(1);
		await k.queue.enqueue(k.ctx.db, 'calendar.remind', payload);
		await advanceTo(at('2026-10-10', '13:31'));
		expect(channel.sent).toHaveLength(1);
	});
});

describe('recipients', () => {
	it('reminds every member who can see the calendar when the event is for the whole family', async () => {
		const ann = await person('admin', 'en');
		const bob = await person('member', 'en');
		const kid = await person('supervised', 'tr');
		const gone = await person('member', 'en');
		await k.runner.invoke('core.archiveMember', { memberId: gone.id }, ann.actor);
		await create({ title: 'Picnic', date: '2026-10-10', startTime: '12:00' }, ann.actor);
		await advanceTo(at('2026-10-10', '11:30'));
		const canView = [ann, bob, kid].filter((m) =>
			k.access.effective(m.actor.roleId as string).has('calendar.view'),
		);
		expect(canView.length).toBeGreaterThanOrEqual(2);
		expect(recipients()).toEqual(canView.map((m) => m.id).sort());
	});
});

describe('all-day events', () => {
	it('reminds at 09:00 local time on the day by default', async () => {
		const ann = await person('admin', 'en');
		await create(
			{ title: 'Holiday', date: '2026-10-12', allDay: true, memberIds: [ann.id] },
			ann.actor,
		);
		await advanceTo(at('2026-10-12', '09:00') - 1);
		expect(channel.sent).toHaveLength(0);
		await advanceTo(at('2026-10-12', '09:00'));
		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]?.message.body).toBe('en|calendar:reminder_all_day|{}');
		// 09:00 in Istanbul is 06:00 UTC.
		expect(new Date(at('2026-10-12', '09:00')).toISOString()).toBe('2026-10-12T06:00:00.000Z');
	});

	it('can remind at 21:00 the evening before', async () => {
		const ann = await person('admin', 'en');
		await create(
			{ title: 'Trip', date: '2026-10-12', allDay: true, memberIds: [ann.id], reminder: 720 },
			ann.actor,
		);
		await advanceTo(at('2026-10-11', '20:59'));
		expect(channel.sent).toHaveLength(0);
		await advanceTo(at('2026-10-11', '21:00'));
		expect(channel.sent).toHaveLength(1);
	});

	it('fires at local time across a daylight saving change (Europe/Berlin, March 2026)', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'Europe/Berlin' },
			systemActor('test'),
		);
		const ann = await person('admin', 'en');
		k.clock.set(at('2026-03-20', '10:00', 'Europe/Berlin'));
		await create(
			{
				title: 'Sunday market',
				date: '2026-03-22',
				allDay: true,
				memberIds: [ann.id],
				recurrence: { freq: 'weekly', interval: 1, byDay: ['SU'] },
			},
			ann.actor,
		);
		await create(
			{
				title: 'Morning run',
				date: '2026-03-28',
				startTime: '08:00',
				memberIds: [ann.id],
				recurrence: { freq: 'daily', interval: 1 },
			},
			ann.actor,
		);
		const titles = () => channel.sent.map((s) => s.message.title);
		const count = (name: string) => titles().filter((t) => t.includes(name)).length;
		// Winter time: 09:00 local = 08:00 UTC.
		await advanceTo(Date.UTC(2026, 2, 22, 8, 0));
		expect(count('Sunday market')).toBe(1);
		// Saturday 08:00 run, reminded at 07:30 local = 06:30 UTC.
		await advanceTo(Date.UTC(2026, 2, 28, 6, 30));
		expect(count('Morning run')).toBe(1);
		// The clocks went forward on Sunday 29 March: 07:30 local = 05:30 UTC ...
		await advanceTo(Date.UTC(2026, 2, 29, 5, 30) - 1);
		expect(count('Morning run')).toBe(1);
		await advanceTo(Date.UTC(2026, 2, 29, 5, 30));
		expect(count('Morning run')).toBe(2);
		// ... and 09:00 local = 07:00 UTC, no longer 08:00.
		await advanceTo(Date.UTC(2026, 2, 29, 7, 0) - 1);
		expect(count('Sunday market')).toBe(1);
		await advanceTo(Date.UTC(2026, 2, 29, 7, 0));
		expect(count('Sunday market')).toBe(2);
		expect(at('2026-03-29', '09:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 7, 0));
	});

	it('fires at local time across the October change (Europe/Berlin, 25 October 2026)', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'Europe/Berlin' },
			systemActor('test'),
		);
		const ann = await person('admin', 'en');
		k.clock.set(at('2026-10-20', '10:00', 'Europe/Berlin'));
		await create(
			{
				title: 'Morning run',
				date: '2026-10-24',
				startTime: '08:00',
				memberIds: [ann.id],
				recurrence: { freq: 'daily', interval: 1 },
			},
			ann.actor,
		);
		await create(
			{ title: 'Open day', date: '2026-10-25', allDay: true, memberIds: [ann.id] },
			ann.actor,
		);
		const count = (name: string) =>
			channel.sent.filter((s) => s.message.title.includes(name)).length;
		// Summer time (UTC+2): 07:30 local = 05:30 UTC.
		await advanceTo(Date.UTC(2026, 9, 24, 5, 30) - 1);
		expect(count('Morning run')).toBe(0);
		await advanceTo(Date.UTC(2026, 9, 24, 5, 30));
		expect(count('Morning run')).toBe(1);
		// The clocks went back on Sunday 25 October (UTC+1): 07:30 local = 06:30 UTC ...
		await advanceTo(Date.UTC(2026, 9, 25, 6, 30) - 1);
		expect(count('Morning run')).toBe(1);
		await advanceTo(Date.UTC(2026, 9, 25, 6, 30));
		expect(count('Morning run')).toBe(2);
		// ... and 09:00 local = 08:00 UTC.
		await advanceTo(Date.UTC(2026, 9, 25, 8, 0) - 1);
		expect(count('Open day')).toBe(0);
		await advanceTo(Date.UTC(2026, 9, 25, 8, 0));
		expect(count('Open day')).toBe(1);
		expect(at('2026-10-25', '09:00', 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 8, 0));
	});
});

describe('recurring events', () => {
	const weekly = {
		title: 'Swimming',
		date: '2026-10-06',
		startTime: '17:30',
		recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
	};

	it('reminds each occurrence in turn', async () => {
		const ann = await person('admin', 'en');
		await create({ ...weekly, memberIds: [ann.id] }, ann.actor);
		await advanceTo(at('2026-10-06', '17:00'));
		expect(channel.sent).toHaveLength(1);
		await advanceTo(at('2026-10-12', '12:00'));
		expect(channel.sent).toHaveLength(1);
		await advanceTo(at('2026-10-13', '17:00'));
		expect(channel.sent).toHaveLength(2);
		await advanceTo(at('2026-10-20', '17:00'));
		expect(channel.sent).toHaveLength(3);
	});

	it('skips a skipped occurrence and carries on with the next (skipped before the first reminder)', async () => {
		const ann = await person('admin', 'en');
		const id = await create({ ...weekly, memberIds: [ann.id] }, ann.actor);
		await k.runner.invoke(
			'calendar.deleteEvent',
			{ id, occurrence: String(at('2026-10-13', '17:30')) },
			ann.actor,
		);
		await advanceTo(at('2026-10-06', '17:00'));
		expect(channel.sent).toHaveLength(1);
		await advanceTo(at('2026-10-13', '17:00'));
		expect(channel.sent).toHaveLength(1);
		await advanceTo(at('2026-10-20', '17:00'));
		expect(channel.sent).toHaveLength(2);
	});

	it('skips an occurrence skipped after the chain reached it', async () => {
		const ann = await person('admin', 'en');
		const id = await create({ ...weekly, memberIds: [ann.id] }, ann.actor);
		await advanceTo(at('2026-10-06', '17:00'));
		expect(channel.sent).toHaveLength(1);
		// The next reminder (13 October) is already planned; skipping it plans the one after.
		await k.runner.invoke(
			'calendar.deleteEvent',
			{ id, occurrence: String(at('2026-10-13', '17:30')) },
			ann.actor,
		);
		await advanceTo(at('2026-10-13', '17:00'));
		expect(channel.sent).toHaveLength(1);
		await advanceTo(at('2026-10-20', '17:00'));
		expect(channel.sent).toHaveLength(2);
	});
});

describe('events proposed by the AI', () => {
	it('plans the reminder when the draft is approved, with the same defaults', async () => {
		const ann = await person('admin', 'en');
		const proposed = await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'School trip', date: '2026-10-14', startTime: '09:00', memberIds: [ann.id] },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		if (proposed.status !== 'drafted') throw new Error('expected a draft');
		await advanceTo(at('2026-10-06', '12:00'));
		const reminders = () => channel.sent.filter((s) => s.message.title.includes('reminder_title'));
		expect(reminders()).toHaveLength(0);
		await k.runner.approveDraft(proposed.draftId, ann.actor);
		await advanceTo(at('2026-10-14', '08:30') - 1);
		expect(reminders()).toHaveLength(0);
		await advanceTo(at('2026-10-14', '08:30'));
		expect(reminders()).toHaveLength(1);
	});
});
