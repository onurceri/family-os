import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import ICAL from 'ical.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	EventInputSchema,
	MAX_TAG_LENGTH,
	normalizeTags,
	SUBSCRIPTION_COLORS,
	tagKey,
} from '../src/contract/index.ts';
import { parseCalendar } from '../src/server/ical-import.ts';
import calendar, { createEvent } from '../src/server/index.ts';
import { events } from '../src/server/store.ts';
import { ics } from './fixtures.ts';

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

const create = async (input: Record<string, unknown>) => {
	const r = await k.runner.invoke<{ id: string; tags: string[] }>(
		'calendar.createEvent',
		{ title: 'Event', date: '2026-10-20', startTime: '10:00', ...input },
		admin.actor,
	);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output;
};
const listTags = (): Promise<{ name: string; color: string }[]> =>
	k.route('calendar.listTags').call({});
const range = (): Promise<{ title: string; tags: string[] }[]> =>
	k.route('calendar.listOccurrences').call({ query: { from: '2026-10-01', to: '2026-10-31' } });
const stored = async (id: string) =>
	(
		await events(k.ctx.db)
			.selectFrom('calendar_events')
			.select('tags')
			.where('id', '=', id)
			.executeTakeFirstOrThrow()
	).tags;

describe('tag normalisation', () => {
	it('trims, collapses spacing, cuts long names and drops duplicates in any case', () => {
		expect(normalizeTags(['  School ', 'school', 'SCHOOL', 'Doctor  visit', ''])).toEqual([
			'School',
			'Doctor visit',
		]);
		expect(normalizeTags(['x'.repeat(40)])[0]).toHaveLength(MAX_TAG_LENGTH);
		expect(normalizeTags(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(normalizeTags(undefined)).toEqual([]);
	});

	it('treats Turkish dotted and dotless I as the same letter as their plain forms', () => {
		expect(tagKey('Işık')).toBe(tagKey('ışık'));
		expect(tagKey('İş')).toBe(tagKey('iş'));
		expect(normalizeTags(['Okul', 'okul', 'OKUL'])).toEqual(['Okul']);
	});

	it('limits the input: at most 5 tags of 24 characters', () => {
		const base = { title: 'A', date: '2026-10-20', startTime: '10:00' };
		expect(EventInputSchema.safeParse({ ...base, tags: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(
			true,
		);
		expect(
			EventInputSchema.safeParse({ ...base, tags: ['a', 'b', 'c', 'd', 'e', 'f'] }).success,
		).toBe(false);
		expect(EventInputSchema.safeParse({ ...base, tags: ['x'.repeat(25)] }).success).toBe(false);
		expect(EventInputSchema.safeParse({ ...base, tags: [''] }).success).toBe(false);
		expect(EventInputSchema.safeParse(base).success).toBe(true);
	});
});

describe('tags on events', () => {
	it('stores clean tags, returns them in details and occurrences, and builds the family list', async () => {
		const a = await create({ title: 'Dentist', tags: [' Health ', 'health', 'Teeth'] });
		expect(a.tags).toEqual(['Health', 'Teeth']);
		const detail = await k.route('calendar.getEvent').call({ params: { eventId: a.id } });
		expect(detail.tags).toEqual(['Health', 'Teeth']);
		expect((await range())[0]).toMatchObject({ title: 'Dentist', tags: ['Health', 'Teeth'] });

		await create({ title: 'Parents evening', tags: ['HEALTH', 'School'] });
		const list = await listTags();
		// One entry per tag; the first spelling stays; every tag has its own palette colour.
		expect(list.map((t) => t.name)).toEqual(['Health', 'School', 'Teeth']);
		expect(new Set(list.map((t) => t.color)).size).toBe(3);
		for (const t of list) expect(SUBSCRIPTION_COLORS).toContain(t.color);
		expect(await stored(a.id)).toBe('["Health","Teeth"]');
	});

	it('keeps events without tags as null and clears tags on update', async () => {
		const a = await create({});
		expect(a.tags).toEqual([]);
		expect(await stored(a.id)).toBeNull();
		await k.runner.invoke(
			'calendar.updateEvent',
			{ id: a.id, event: { title: 'E', date: '2026-10-20', startTime: '10:00', tags: ['car'] } },
			admin.actor,
		);
		expect(await stored(a.id)).toBe('["car"]');
		expect((await listTags()).map((t) => t.name)).toEqual(['car']);
		await k.runner.invoke(
			'calendar.updateEvent',
			{ id: a.id, event: { title: 'E', date: '2026-10-20', startTime: '10:00' } },
			admin.actor,
		);
		expect(await stored(a.id)).toBeNull();
	});

	it('tells the AI to prefer existing family tags, and which ones exist', async () => {
		expect(createEvent.ai?.guidance).toContain('existing family tags');
		const schema = JSON.stringify(z.toJSONSchema(EventInputSchema, { io: 'input' }));
		expect(schema).toContain('Reuse one of the family');
		// No example list for the model to copy: the real tags come from the family.
		expect(schema).not.toContain('school, health, car');

		const empty = await k.runner.invoke('calendar.aiContext', {}, systemActor('test'));
		expect(empty).toMatchObject({ status: 'applied', output: { items: [], plain: true } });
		await create({ tags: ['Swim club', 'school'] });
		const result = await k.runner.invoke<{ kind: string; items: { label: string }[] }>(
			'calendar.aiContext',
			{},
			admin.actor,
		);
		if (result.status !== 'applied') throw new Error('expected applied');
		expect(result.output.items.map((i) => i.label)).toEqual(['school', 'Swim club']);
	});
});

describe('renaming, recolouring and deleting tags', () => {
	it('renames a tag on every event in one go and keeps reminders valid', async () => {
		const a = await create({ title: 'A', tags: ['School', 'Car'] });
		const b = await create({ title: 'B', tags: ['school'] });
		const before = await events(k.ctx.db)
			.selectFrom('calendar_events')
			.select('updated_at')
			.where('id', '=', a.id)
			.executeTakeFirstOrThrow();
		k.clock.set(k.clock.now() + 1000);
		const r = await k.runner.invoke(
			'calendar.updateTag',
			{ name: 'SCHOOL', newName: 'Okul', color: SUBSCRIPTION_COLORS[7] },
			admin.actor,
		);
		expect(r.status).toBe('applied');
		expect(await stored(a.id)).toBe('["Okul","Car"]');
		expect(await stored(b.id)).toBe('["Okul"]');
		expect(await listTags()).toEqual([
			{ name: 'Car', color: expect.any(String) },
			{ name: 'Okul', color: SUBSCRIPTION_COLORS[7] },
		]);
		// `updated_at` guards planned reminders: a rename must not touch it.
		const after = await events(k.ctx.db)
			.selectFrom('calendar_events')
			.select('updated_at')
			.where('id', '=', a.id)
			.executeTakeFirstOrThrow();
		expect(after.updated_at).toBe(before.updated_at);
	});

	it('merges into an existing tag without duplicating it on an event', async () => {
		const a = await create({ title: 'A', tags: ['School', 'Okul'] });
		const b = await create({ title: 'B', tags: ['School'] });
		await k.runner.invoke('calendar.updateTag', { name: 'School', newName: 'okul' }, admin.actor);
		expect(await stored(a.id)).toBe('["Okul"]');
		expect(await stored(b.id)).toBe('["Okul"]');
		expect((await listTags()).map((t) => t.name)).toEqual(['Okul']);
	});

	it('changes only the spelling or only the colour', async () => {
		const a = await create({ tags: ['school'] });
		await k.runner.invoke('calendar.updateTag', { name: 'school', newName: 'School' }, admin.actor);
		expect(await stored(a.id)).toBe('["School"]');
		const color = SUBSCRIPTION_COLORS[3];
		await k.runner.invoke('calendar.updateTag', { name: 'school', color }, admin.actor);
		expect(await listTags()).toEqual([{ name: 'School', color }]);
	});

	it('deletes a tag from the list and from every event', async () => {
		const a = await create({ tags: ['School', 'Car'] });
		const b = await create({ tags: ['school'] });
		await k.runner.invoke('calendar.deleteTag', { name: 'SCHOOL' }, admin.actor);
		expect(await stored(a.id)).toBe('["Car"]');
		expect(await stored(b.id)).toBeNull();
		expect((await listTags()).map((t) => t.name)).toEqual(['Car']);
		await expect(
			k.runner.invoke('calendar.deleteTag', { name: 'School' }, admin.actor),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('needs the right to edit the calendar', async () => {
		await create({ tags: ['School'] });
		const guest = await k.member('guest');
		await expect(
			k.runner.invoke('calendar.deleteTag', { name: 'School' }, guest.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke('calendar.updateTag', { name: 'School', color: '#3f7fb5' }, guest.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('tags in ICS', () => {
	const feedText = async () => {
		const made = await k.runner.invoke<{ path: string }>(
			'calendar.createFeed',
			{ scope: 'family' },
			admin.actor,
		);
		if (made.status !== 'applied') throw new Error('expected applied');
		const out = await k.route('calendar.getFeed').call({
			params: { file: made.output.path.split('/').pop() },
			actor: { kind: 'system', source: 'anonymous' },
		});
		return out.text as string;
	};

	it('writes CATEGORIES with escaped names and reads them back', async () => {
		await create({ title: 'Check-up', tags: ['health', 'Mum, Dad; and me'] });
		await create({ title: 'Plain' });
		const text = (await feedText()).replace(/\r\n /g, '');
		expect(text).toContain('CATEGORIES:health,Mum\\, Dad\\; and me\r\n');
		expect(text.match(/CATEGORIES/g)).toHaveLength(1);

		const parsed = parseCalendar(text, TZ, k.clock.now());
		expect(parsed.find((e) => e.title === 'Check-up')?.tags).toEqual([
			'health',
			'Mum, Dad; and me',
		]);
		expect(parsed.find((e) => e.title === 'Plain')?.tags).toEqual([]);
	});

	it('keeps the CATEGORIES of an imported feed as read-only tags', async () => {
		const feed = ics(
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//School//EN',
			'BEGIN:VEVENT',
			'UID:trip@school.example',
			'DTSTAMP:20261001T000000Z',
			'DTSTART:20261020T090000Z',
			'DTEND:20261020T100000Z',
			'SUMMARY:Trip',
			'CATEGORIES:School,Outing',
			'CATEGORIES:school',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:plain@school.example',
			'DTSTAMP:20261001T000000Z',
			'DTSTART:20261021T090000Z',
			'SUMMARY:Plain',
			'END:VEVENT',
			'END:VCALENDAR',
		);
		// ical.js reads what we claim to write: sanity check the fixture itself.
		expect(new ICAL.Component(ICAL.parse(feed)).name).toBe('vcalendar');

		const url = 'https://school.example/cal.ics';
		k.http.serve(url, { text: feed });
		const added = await k.runner.invoke(
			'calendar.addSubscription',
			{ name: 'School', url },
			admin.actor,
		);
		expect(added.status).toBe('applied');
		await k.worker.drain();

		const list = await range();
		expect(list.find((o) => o.title === 'Trip')?.tags).toEqual(['School', 'Outing']);
		expect(list.find((o) => o.title === 'Plain')?.tags).toEqual([]);
		// Feed tags never enter the family's own list.
		expect(await listTags()).toEqual([]);
	});
});
