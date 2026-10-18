import { type Actor, type DigestOutput, type MemberId, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

// The test clock stands at Thursday 1 January 2026, 12:00 in Istanbul.
const TZ = 'Europe/Istanbul';
let k: TestKernel;
let mara: Awaited<ReturnType<TestKernel['member']>>;
let leo: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	mara = await k.member('admin');
	leo = await k.member('supervised');
});
afterEach(() => k.close());

const ai = (m = mara, roleId = 'admin'): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: m.member.id as MemberId,
	roleId,
});
const add = (input: Record<string, unknown>) =>
	k.runner.invoke('calendar.createEvent', input, mara.actor);
const digest = async (input: Record<string, unknown>, actor: Actor = ai()) => {
	const result = await k.runner.invoke<DigestOutput>('calendar.digest', input, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};
const titles = (out: DigestOutput) => out.items.map((i) => i.title);

describe('calendar.digest', () => {
	it('holds the events of the span, first and last day included, repeats expanded', async () => {
		await add({ title: 'Before', date: '2026-01-04', startTime: '10:00' });
		await add({ title: 'First day', date: '2026-01-05', startTime: '10:00' });
		await add({ title: 'Last day', date: '2026-01-11', allDay: true });
		await add({ title: 'After', date: '2026-01-12', startTime: '10:00' });
		await add({
			title: 'Piano',
			date: '2026-01-01',
			startTime: '17:00',
			endTime: '17:45',
			recurrence: { freq: 'weekly', byDay: ['TH'] },
		});
		const out = await digest({ from: '2026-01-05', to: '2026-01-11' });
		expect(titles(out)).toEqual(['First day', 'Piano', 'Last day']);
		expect(out.items[1]).toMatchObject({
			kind: 'event',
			date: '2026-01-08',
			time: '17:00',
			end: { time: '17:45' },
			extra: { occurrence: expect.any(String) },
		});
		expect(out.items[2]).toMatchObject({ date: '2026-01-11', allDay: true });
		expect(out.items[0]?.handle).toMatch(/^cal_event_/);
		expect(out.truncated).toBe(false);
		expect(out.nextAfter).toBeUndefined();
	});

	it('carries the notes, so what to bring is in the answer', async () => {
		// "What should I bring to the football match?" was answered "no notes".
		await add({
			title: 'Football match',
			date: '2026-01-10',
			startTime: '10:00',
			location: 'Stadion',
			notes: 'Bring white shirt, shin pads & water',
		});
		const [match] = (await digest({ from: '2026-01-10', to: '2026-01-10' })).items;
		expect(match).toMatchObject({
			notes: 'Bring white shirt, shin pads & water',
			extra: { location: 'Stadion' },
		});
	});

	it('keeps the people asked about and the whole family, and leaves the others out', async () => {
		await add({
			title: 'Leo swimming',
			date: '2026-01-06',
			allDay: true,
			memberIds: [leo.member.id],
		});
		await add({
			title: 'Mara dentist',
			date: '2026-01-06',
			allDay: true,
			memberIds: [mara.member.id],
		});
		await add({ title: 'Family dinner', date: '2026-01-06', allDay: true });
		const out = await digest({ from: '2026-01-06', to: '2026-01-06', memberIds: [leo.member.id] });
		expect(titles(out).sort()).toEqual(['Family dinner', 'Leo swimming']);
		expect(out.items.find((i) => i.title === 'Leo swimming')?.people).toEqual([leo.member.id]);
	});

	it('ranks what the words name first and keeps every event', async () => {
		// "Do we need to pick up Leo on Thursday?": the event is the Swimming lesson.
		await add({ title: 'Swimming lesson', date: '2026-01-08', startTime: '16:30' });
		await add({ title: 'Dentist', date: '2026-01-08', startTime: '09:00' });
		const picked = await digest({ from: '2026-01-08', to: '2026-01-08', about: ['pick up'] });
		expect(titles(picked)).toEqual(['Dentist', 'Swimming lesson']);
		const named = await digest({ from: '2026-01-08', to: '2026-01-08', about: ['swimming'] });
		expect(titles(named)).toEqual(['Swimming lesson', 'Dentist']);
	});

	it('says what comes next when the span is empty, even months later', async () => {
		await add({ title: 'Date night', date: '2026-03-20', startTime: '19:00' });
		const out = await digest({ from: '2026-01-10', to: '2026-01-11' });
		expect(out.items).toEqual([]);
		expect(out.nextAfter).toMatchObject({ title: 'Date night', date: '2026-03-20' });
		// The next event is one of the people asked about.
		await add({ title: 'Leo match', date: '2026-02-01', allDay: true, memberIds: [leo.member.id] });
		const forMara = await digest({
			from: '2026-01-10',
			to: '2026-01-11',
			memberIds: [mara.member.id],
		});
		expect(forMara.nextAfter?.title).toBe('Date night');
	});

	it('says where the events of today stand', async () => {
		await add({ title: 'Breakfast', date: '2026-01-01', startTime: '08:00' });
		await add({ title: 'Dinner', date: '2026-01-01', startTime: '19:00' });
		await add({ title: 'Tomorrow', date: '2026-01-02', startTime: '19:00' });
		const out = await digest({ from: '2026-01-01', to: '2026-01-02' });
		expect(out.items.map((i) => i.status)).toEqual(['past', 'upcoming', undefined]);
	});

	it('cuts a crowded span and says so', async () => {
		for (let i = 0; i < 61; i++)
			await add({ title: `Event ${i}`, date: '2026-01-07', allDay: true });
		const out = await digest({ from: '2026-01-07', to: '2026-01-07' });
		expect(out.items).toHaveLength(60);
		expect(out.truncated).toBe(true);
	});

	it('gives nothing to an AI whose area is off', async () => {
		await add({ title: 'Dentist', date: '2026-01-06', allDay: true });
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'calendar', access: 'off' },
			mara.actor,
		);
		await expect(
			k.runner.invoke('calendar.digest', { from: '2026-01-06', to: '2026-01-06' }, ai()),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('calendar.findEvents', () => {
	type Found = {
		events: { title: string; notes?: string }[];
		unmatched?: { title: string }[];
		note?: string;
	};
	const find = async (input: Record<string, unknown>) => {
		const result = await k.runner.invoke<Found>('calendar.findEvents', input, ai());
		if (result.status !== 'applied') throw new Error('expected a read');
		return result.output;
	};

	it('returns the notes of the events it finds', async () => {
		await add({
			title: 'Football match',
			date: '2026-01-10',
			allDay: true,
			notes: 'Bring shin pads',
		});
		await add({ title: 'Dentist', date: '2026-01-10', allDay: true });
		const found = await find({ from: '2026-01-10' });
		expect(found.events).toEqual([
			expect.objectContaining({ title: 'Dentist' }),
			expect.objectContaining({ title: 'Football match', notes: 'Bring shin pads' }),
		]);
		expect('notes' in (found.events[0] ?? {})).toBe(false);
	});

	it('lists the other events of a text search that found nothing only over a week at most', async () => {
		await add({ title: 'Swimming lesson', date: '2026-01-08', startTime: '16:30' });
		const week = await find({ from: '2026-01-05', to: '2026-01-11', text: 'pick up' });
		expect(week.unmatched?.map((e) => e.title)).toEqual(['Swimming lesson']);
		const long = await find({ text: 'pick up' });
		expect(long.unmatched).toBeUndefined();
		expect(long.note).toContain('Search a shorter range');
		const eight = await find({ from: '2026-01-04', to: '2026-01-11', text: 'pick up' });
		expect(eight.unmatched).toBeUndefined();
	});
});
