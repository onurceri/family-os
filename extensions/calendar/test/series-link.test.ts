import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import ICAL from 'ical.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Occurrence } from '../src/contract/index.ts';
import { parseCalendar } from '../src/server/ical-import.ts';
import calendar from '../src/server/index.ts';
import { events } from '../src/server/store.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: { actor: Actor; member: { id: string } };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-12', '09:00', TZ));
	admin = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

const range = (from: string, to: string) =>
	k.route('calendar.listOccurrences').call({ query: { from, to } }) as Promise<Occurrence[]>;

async function create(input: Record<string, unknown>): Promise<string> {
	const made = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, admin.actor);
	if (made.status !== 'applied') throw new Error('expected applied');
	return made.output.id;
}

const bins = {
	title: 'Take out the bins',
	date: '2026-10-13',
	startTime: '19:00',
	endTime: '19:30',
	recurrence: { freq: 'weekly', byDay: ['TU'] },
};

/** Moves the bins of Tuesday 20 October to Wednesday 21 October, 20:00, with "Only this one". */
async function moveSecond(id: string) {
	const moved = await k.runner.invoke<{
		event: { id: string };
		split?: { seriesId: string; occurrence: string };
	}>(
		'calendar.changeEvent',
		{ id, occurrence: '2026-10-20', date: '2026-10-21', startTime: '20:00' },
		admin.actor,
	);
	if (moved.status !== 'applied') throw new Error('expected applied');
	return moved.output;
}

const twentieth = epochOf('2026-10-20', '19:00', TZ);

const form = (over: Record<string, unknown>) => ({
	title: 'Bins',
	allDay: false,
	date: '2026-10-21',
	endDate: null,
	startTime: '20:00',
	endTime: '20:30',
	location: null,
	notes: null,
	memberIds: [],
	recurrence: null,
	reminder: null,
	tags: null,
	...over,
});

async function feedText(scope: string, actor: Actor): Promise<string> {
	const made = await k.runner.invoke<{ path: string }>('calendar.createFeed', { scope }, actor);
	if (made.status !== 'applied') throw new Error('expected applied');
	const file = made.output.path.split('/').pop();
	const out = (await k.route('calendar.getFeed').call({
		params: { file },
		actor: { kind: 'system', source: 'anonymous' },
	})) as { text: string };
	return out.text;
}

const vevents = (text: string) => {
	const root = new ICAL.Component(ICAL.parse(text));
	for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
	return root.getAllSubcomponents('vevent');
};

describe('a date moved out of a series keeps its link', () => {
	it('"Only this one" through changeEvent stores the series and the date it replaced', async () => {
		const id = await create(bins);
		const out = await moveSecond(id);
		expect(out.split).toEqual({ seriesId: id, occurrence: String(twentieth) });
		const row = await events(k.ctx.db)
			.selectFrom('calendar_events')
			.select(['series_id', 'recurrence_key'])
			.where('id', '=', out.event.id)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ series_id: id, recurrence_key: String(twentieth) });
		expect(out.event).toMatchObject({ seriesId: id, recurrenceKey: String(twentieth) });
	});

	it('"Only this one" through the form links it the same way, and all-day dates by their date', async () => {
		const id = await create(bins);
		const done = await k.runner.invoke<{ id: string }>(
			'calendar.updateEvent',
			{ id, event: form({}), occurrence: '2026-10-20', scope: 'this' },
			admin.actor,
		);
		if (done.status !== 'applied') throw new Error('expected applied');
		const day = await range('2026-10-21', '2026-10-21');
		expect(day[0]).toMatchObject({
			eventId: done.output.id,
			seriesId: id,
			recurrenceKey: String(twentieth),
		});

		const market = await create({
			title: 'Market',
			date: '2026-10-13',
			allDay: true,
			recurrence: { freq: 'weekly', byDay: ['TU'] },
		});
		const moved = await k.runner.invoke(
			'calendar.changeEvent',
			{ id: market, occurrence: '2026-10-20', date: '2026-10-22' },
			admin.actor,
		);
		expect(moved.status).toBe('applied');
		expect((await range('2026-10-22', '2026-10-22'))[0]).toMatchObject({
			seriesId: market,
			recurrenceKey: '2026-10-20',
		});
	});

	it('lists the moved date with its series, and every other occurrence without', async () => {
		const id = await create(bins);
		const { event } = await moveSecond(id);
		const all = await range('2026-10-12', '2026-10-31');
		const movedDate = all.find((o) => o.eventId === event.id);
		expect(movedDate).toMatchObject({ seriesId: id, recurrenceKey: String(twentieth) });
		for (const o of all.filter((x) => x.eventId === id)) {
			expect(o).not.toHaveProperty('seriesId');
			expect(o).not.toHaveProperty('recurrenceKey');
		}
	});

	it('"This one and after" splits keep working: only the later moved dates follow the new series', async () => {
		const id = await create(bins);
		const { event: early } = await moveSecond(id);
		const later = await k.runner.invoke<{ event: { id: string } }>(
			'calendar.changeEvent',
			{ id, occurrence: '2026-11-03', date: '2026-11-04', startTime: '20:00' },
			admin.actor,
		);
		if (later.status !== 'applied') throw new Error('expected applied');
		const split = await k.runner.invoke<{ id: string }>(
			'calendar.updateEvent',
			{
				id,
				event: form({
					date: '2026-10-27',
					startTime: '18:00',
					endTime: '18:30',
					recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
				}),
				occurrence: String(epochOf('2026-10-27', '19:00', TZ)),
				scope: 'following',
			},
			admin.actor,
		);
		if (split.status !== 'applied') throw new Error('expected applied');
		const link = async (eventId: string) =>
			(
				await events(k.ctx.db)
					.selectFrom('calendar_events')
					.select('series_id')
					.where('id', '=', eventId)
					.executeTakeFirstOrThrow()
			).series_id;
		expect(await link(early.id)).toBe(id);
		expect(await link(later.output.event.id)).toBe(split.output.id);
	});
});

describe('putting a moved date back', () => {
	it('finds the moved date by its link, without being told which one it is', async () => {
		const id = await create(bins);
		const { event } = await moveSecond(id);
		const back = await k.runner.invoke(
			'calendar.putOccurrenceBack',
			{ id, occurrence: String(twentieth) },
			admin.actor,
		);
		expect(back.status).toBe('applied');
		const all = await range('2026-10-12', '2026-10-31');
		expect(all.some((o) => o.eventId === event.id)).toBe(false);
		expect(all.filter((o) => o.eventId === id).map((o) => o.start)).toContain(twentieth);
	});

	it('still takes the id of a date moved before the link existed', async () => {
		const id = await create(bins);
		const { event } = await moveSecond(id);
		await events(k.ctx.db)
			.updateTable('calendar_events')
			.set({ series_id: null, recurrence_key: null })
			.where('id', '=', event.id)
			.execute();
		await k.runner.invoke(
			'calendar.putOccurrenceBack',
			{ id, occurrence: String(twentieth), splitId: event.id },
			admin.actor,
		);
		const all = await range('2026-10-12', '2026-10-31');
		expect(all.some((o) => o.eventId === event.id)).toBe(false);
		expect(all.filter((o) => o.eventId === id).map((o) => o.start)).toContain(twentieth);
	});
});

describe('deleting a series', () => {
	it('takes its moved dates with it, and bringing the series back brings them back', async () => {
		const id = await create(bins);
		const { event } = await moveSecond(id);
		const other = await create({ title: 'Doctor', date: '2026-10-21', startTime: '09:00' });
		await k.runner.invoke('calendar.deleteEvent', { id }, admin.actor);
		let all = await range('2026-10-12', '2026-10-31');
		expect(all.map((o) => o.eventId)).toEqual([other]);
		await k.runner.invoke('calendar.restoreEvent', { id }, admin.actor);
		all = await range('2026-10-12', '2026-10-31');
		expect(all.some((o) => o.eventId === event.id)).toBe(true);
		expect(all.some((o) => o.eventId === id)).toBe(true);
	});

	it('does not bring back a moved date that was deleted on its own before', async () => {
		const id = await create(bins);
		const { event } = await moveSecond(id);
		k.clock.advance(60_000);
		await k.runner.invoke('calendar.deleteEvent', { id: event.id }, admin.actor);
		k.clock.advance(60_000);
		await k.runner.invoke('calendar.deleteEvent', { id }, admin.actor);
		k.clock.advance(60_000);
		await k.runner.invoke('calendar.restoreEvent', { id }, admin.actor);
		const all = await range('2026-10-12', '2026-10-31');
		expect(all.some((o) => o.eventId === event.id)).toBe(false);
	});
});

describe('the ICS feed', () => {
	it('writes a moved date as an override of its series and drops the EXDATE it made', async () => {
		const id = await create(bins);
		const { event } = await moveSecond(id);
		// A second, plain skipped date keeps its EXDATE.
		await k.runner.invoke(
			'calendar.deleteEvent',
			{ id, occurrence: String(epochOf('2026-10-27', '19:00', TZ)) },
			admin.actor,
		);
		const text = await feedText('family', admin.actor);
		const unfolded = text.replace(/\r\n /g, '');
		const parts = vevents(text);
		expect(parts.map((p) => String(p.getFirstPropertyValue('uid')))).toEqual([
			`${id}@familyos`,
			`${id}@familyos`,
		]);
		expect(unfolded).not.toContain(event.id);
		expect(unfolded).toContain('RECURRENCE-ID;TZID=Europe/Istanbul:20261020T190000');
		const blocks = unfolded.split('BEGIN:VEVENT');
		const master = blocks.find((p) => p.includes('RRULE')) as string;
		expect(master).toContain('EXDATE;TZID=Europe/Istanbul:20261027T190000');
		expect(master).not.toContain('20261020T190000');
		const override = blocks.find((p) => p.includes('RECURRENCE-ID')) as string;
		expect(override).toContain('DTSTART:20261021T170000Z');
		expect(override).not.toContain('RRULE');

		// A calendar app expands it: the 20th is replaced by the override, not shown twice.
		const masterEvent = new ICAL.Event(parts.find((p) => p.hasProperty('rrule')) as never);
		for (const p of parts.filter((x) => x.hasProperty('recurrence-id')))
			masterEvent.relateException(new ICAL.Event(p as never));
		const iterator = masterEvent.iterator();
		const seen: number[] = [];
		for (let i = 0; i < 3; i++) {
			const next = iterator.next();
			if (!next) break;
			seen.push(masterEvent.getOccurrenceDetails(next).startDate.toUnixTime() * 1000);
		}
		expect(seen).toEqual([
			epochOf('2026-10-13', '19:00', TZ),
			epochOf('2026-10-21', '20:00', TZ),
			epochOf('2026-11-03', '19:00', TZ),
		]);
	});

	it('is read back by our own importer as an override of the series', async () => {
		const id = await create(bins);
		await moveSecond(id);
		const text = await feedText('family', admin.actor);
		const parsed = parseCalendar(text, TZ, k.clock.now());
		const series = parsed.find((p) => p.recurrenceKey === '' && p.rrule);
		const override = parsed.find((p) => p.recurrenceKey === String(twentieth));
		expect(series?.uid).toBe(`${id}@familyos`);
		expect(override?.uid).toBe(`${id}@familyos`);
		expect(override?.startsAt).toBe(epochOf('2026-10-21', '20:00', TZ));
		expect(series?.exdates).toContain(twentieth);
	});

	it('writes an all-day override with a date RECURRENCE-ID', async () => {
		const market = await create({
			title: 'Market',
			date: '2026-10-13',
			allDay: true,
			recurrence: { freq: 'weekly', byDay: ['TU'] },
		});
		await k.runner.invoke(
			'calendar.changeEvent',
			{ id: market, occurrence: '2026-10-20', date: '2026-10-22' },
			admin.actor,
		);
		const text = (await feedText('family', admin.actor)).replace(/\r\n /g, '');
		expect(text).toContain('RECURRENCE-ID;VALUE=DATE:20261020');
		const master = text.split('BEGIN:VEVENT').find((p) => p.includes('RRULE')) as string;
		expect(master).not.toContain('EXDATE');
	});

	it('writes a moved date as an event of its own when its series is not in the feed', async () => {
		const mum = await k.member('member');
		const id = await create({ ...bins, memberIds: [admin.member.id] });
		const { event } = await moveSecond(id);
		await k.runner.invoke(
			'calendar.updateEvent',
			{ id: event.id, event: form({ memberIds: [mum.member.id] }) },
			admin.actor,
		);
		const text = await feedText(mum.member.id, mum.actor);
		expect(text).not.toContain('RECURRENCE-ID');
		expect(text).toContain(`UID:${event.id}@familyos`);
	});
});
