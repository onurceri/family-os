import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import ICAL from 'ical.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { CreatedFeedSchema } from '../src/contract/index.ts';
import { escapeText, foldLine } from '../src/server/ics.ts';
import calendar from '../src/server/index.ts';
import { events } from '../src/server/store.ts';

const TZ = 'Europe/Istanbul';
type Created = z.infer<typeof CreatedFeedSchema>;
let k: TestKernel;
let admin: { actor: Actor; member: { id: string } };
let mum: { actor: Actor; member: { id: string } };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-07', '09:00', TZ));
	admin = await k.member('admin');
	mum = await k.member('member');
});
afterEach(() => k.close());

async function feed(actor: Actor, input: Record<string, unknown>): Promise<Created> {
	const r = await k.runner.invoke<Created>('calendar.createFeed', input, actor);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output;
}

const create = (actor: Actor, input: Record<string, unknown>) =>
	k.runner.invoke('calendar.createEvent', input, actor);

/** Fetches a feed the way the public route does: without a session. */
const fetchFeed = (path: string) =>
	k.route('calendar.getFeed').call({
		params: { file: path.split('/').pop() },
		actor: { kind: 'system', source: 'anonymous' },
	});

const parse = (text: string) => {
	const root = new ICAL.Component(ICAL.parse(text));
	for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
	return root;
};
const vevents = (text: string) => parse(text).getAllSubcomponents('vevent');
const unfolded = (text: string) => text.replace(/\r\n /g, '');

describe('creating and revoking feeds', () => {
	it('lets people create feeds for themselves and managers for the family', async () => {
		const own = await feed(mum.actor, { scope: mum.member.id, label: 'Phone' });
		expect(own.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(own.path).toBe(`/api/v1/calendar/feed/${own.token}.ics`);
		expect(own.feed).toMatchObject({ scope: mum.member.id, includeNotes: false, label: 'Phone' });
		await feed(admin.actor, { scope: 'family', includeNotes: true });
		await expect(
			k.runner.invoke('calendar.createFeed', { scope: 'family' }, mum.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke('calendar.createFeed', { scope: admin.member.id }, mum.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('stores only a hash of the token', async () => {
		const { token } = await feed(mum.actor, { scope: mum.member.id });
		const rows = await events(k.ctx.db).selectFrom('calendar_feeds').selectAll().execute();
		expect(JSON.stringify(rows)).not.toContain(token);
		expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('lists your own feeds (all for managers) without addresses', async () => {
		const a = await feed(mum.actor, { scope: mum.member.id });
		const b = await feed(admin.actor, { scope: 'family' });
		const list = (actor: Actor) => k.route('calendar.listFeeds').call({ actor });
		const mine = await list(mum.actor);
		expect(mine.map((f: { id: string }) => f.id)).toEqual([a.feed.id]);
		const all = await list(admin.actor);
		expect(all.map((f: { id: string }) => f.id).sort()).toEqual([a.feed.id, b.feed.id].sort());
		expect(JSON.stringify(all)).not.toContain(a.token);
		expect(JSON.stringify(all)).not.toContain(b.token);
	});

	it('revokes: owners their own, managers any, others nothing', async () => {
		const a = await feed(mum.actor, { scope: mum.member.id });
		const b = await feed(admin.actor, { scope: 'family' });
		await expect(
			k.runner.invoke('calendar.revokeFeed', { id: b.feed.id }, mum.actor),
		).rejects.toMatchObject({ code: 'not_found' });
		await k.runner.invoke('calendar.revokeFeed', { id: a.feed.id }, mum.actor);
		await k.runner.invoke('calendar.revokeFeed', { id: b.feed.id }, admin.actor);
		await expect(fetchFeed(a.path)).rejects.toMatchObject({ code: 'not_found' });
		await expect(fetchFeed(b.path)).rejects.toMatchObject({ code: 'not_found' });
		expect(await k.route('calendar.listFeeds').call({ actor: admin.actor })).toEqual([]);
	});

	it('serves the feed route to everyone without a session, and only that route', () => {
		const route = k.registry.routes.find((r) => r.route.operationId === 'calendar.getFeed');
		expect(route?.route.requires).toBe('public');
		expect(route?.route.path).toBe('/feed/{file}');
	});
});

describe('serving a feed', () => {
	it('answers 404 for unknown tokens and addresses without .ics', async () => {
		const { token } = await feed(admin.actor, { scope: 'family' });
		for (const file of [
			'nope.ics',
			`${token}`,
			`${token}x.ics`,
			'.ics',
			`${token.toUpperCase()}.ics`,
		]) {
			await expect(k.route('calendar.getFeed').call({ params: { file } })).rejects.toMatchObject({
				code: 'not_found',
			});
		}
	});

	it('returns an ICS calendar with the right headers data', async () => {
		const { path } = await feed(admin.actor, { scope: 'family' });
		await create(admin.actor, { title: 'Doktor', date: '2026-10-10', startTime: '14:00' });
		const result = await fetchFeed(path);
		expect(result.contentType).toBe('text/calendar; charset=utf-8');
		expect(result.cacheControl).toBe('private, max-age=300');
		expect(result.text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
		expect(result.text.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(result.text).not.toMatch(/[^\r]\n/);
		const [event] = vevents(result.text);
		expect(event?.getFirstPropertyValue('summary')).toBe('Doktor');
		expect(String(event?.getFirstPropertyValue('uid'))).toMatch(/^cal_event_.+@familyos$/);
		const start = new ICAL.Event(event as never).startDate;
		expect(start.toUnixTime() * 1000).toBe(epochOf('2026-10-10', '14:00', TZ));
	});

	it('limits a member feed to their events and whole-family events', async () => {
		const dad = await k.member('member');
		await create(admin.actor, { title: 'Everyone', date: '2026-10-10', startTime: '10:00' });
		await create(admin.actor, {
			title: 'Mum only',
			date: '2026-10-10',
			startTime: '11:00',
			memberIds: [mum.member.id],
		});
		await create(admin.actor, {
			title: 'Dad only',
			date: '2026-10-10',
			startTime: '12:00',
			memberIds: [dad.member.id],
		});
		const own = await fetchFeed((await feed(mum.actor, { scope: mum.member.id })).path);
		expect(vevents(own.text).map((e) => e.getFirstPropertyValue('summary'))).toEqual([
			'Everyone',
			'Mum only',
		]);
		const family = await fetchFeed((await feed(admin.actor, { scope: 'family' })).path);
		expect(vevents(family.text)).toHaveLength(3);
	});

	it('leaves notes out unless the creator chose them, and escapes text', async () => {
		await create(admin.actor, {
			title: 'Veli toplantısı, 4-B; salon',
			date: '2026-10-10',
			startTime: '14:00',
			location: 'Çocuk Evi, Şişli; kat 2',
			notes: 'Karne\nGetirmeyi unutma, lütfen; ğüşıöç İ\\n',
		});
		const without = await fetchFeed((await feed(admin.actor, { scope: 'family' })).path);
		expect(without.text).not.toContain('DESCRIPTION');
		expect(without.text).not.toContain('Karne');
		const withNotes = await fetchFeed(
			(await feed(admin.actor, { scope: 'family', includeNotes: true })).path,
		);
		const [event] = vevents(withNotes.text);
		expect(event?.getFirstPropertyValue('summary')).toBe('Veli toplantısı, 4-B; salon');
		expect(event?.getFirstPropertyValue('location')).toBe('Çocuk Evi, Şişli; kat 2');
		expect(event?.getFirstPropertyValue('description')).toBe(
			'Karne\nGetirmeyi unutma, lütfen; ğüşıöç İ\\n',
		);
		// On the wire the specials are escaped.
		expect(unfolded(withNotes.text)).toContain('SUMMARY:Veli toplantısı\\, 4-B\\; salon');
	});

	it('writes all-day events with an exclusive end, multi-day included', async () => {
		await create(admin.actor, {
			title: 'Tatil',
			allDay: true,
			date: '2026-10-12',
			endDate: '2026-10-14',
		});
		await create(admin.actor, { title: 'Bayram', allDay: true, date: '2026-10-29' });
		const { text } = await fetchFeed((await feed(admin.actor, { scope: 'family' })).path);
		const list = vevents(text).map((e) => new ICAL.Event(e));
		const [tatil, bayram] = list;
		expect(tatil?.startDate.isDate).toBe(true);
		expect(tatil?.startDate.toString()).toBe('2026-10-12');
		expect(tatil?.endDate.toString()).toBe('2026-10-15');
		expect(bayram?.endDate.toString()).toBe('2026-10-30');
		expect(text).toContain('DTSTART;VALUE=DATE:20261012');
		expect(text).toContain('DTEND;VALUE=DATE:20261015');
	});

	it('writes a repeating event with its rule, exclusions and time zone', async () => {
		const created = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{
				title: 'Yüzme',
				date: '2026-10-06',
				startTime: '17:30',
				endTime: '18:30',
				recurrence: { freq: 'weekly', byDay: ['TU'] },
			},
			admin.actor,
		);
		if (created.status !== 'applied') throw new Error('expected applied');
		const second = String(epochOf('2026-10-13', '17:30', TZ));
		await k.runner.invoke(
			'calendar.deleteEvent',
			{ id: created.output.id, occurrence: second },
			admin.actor,
		);
		const { text } = await fetchFeed((await feed(admin.actor, { scope: 'family' })).path);
		expect(text).toContain('BEGIN:VTIMEZONE');
		expect(text).toContain('TZID:Europe/Istanbul');
		expect(unfolded(text)).toContain('DTSTART;TZID=Europe/Istanbul:20261006T173000');
		expect(unfolded(text)).toContain('EXDATE;TZID=Europe/Istanbul:20261013T173000');
		const [component] = vevents(text);
		const event = new ICAL.Event(component as never);
		expect(event.isRecurring()).toBe(true);
		// Round trip: ical.js expands the series and honours the exclusion.
		const iterator = event.iterator();
		const starts: number[] = [];
		for (let i = 0; i < 4; i++) starts.push(iterator.next().toUnixTime() * 1000);
		expect(starts).toEqual(
			['2026-10-06', '2026-10-20', '2026-10-27', '2026-11-03'].map((d) => epochOf(d, '17:30', TZ)),
		);
	});

	it('keeps daylight saving right for a zone that has it', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'Europe/Berlin' },
			systemActor('test'),
		);
		await create(admin.actor, {
			title: 'Choir',
			date: '2026-10-20',
			startTime: '18:00',
			recurrence: { freq: 'weekly', byDay: ['TU'] },
		});
		const { text } = await fetchFeed((await feed(admin.actor, { scope: 'family' })).path);
		const event = new ICAL.Event(vevents(text)[0] as never);
		const it = event.iterator();
		const starts: number[] = [];
		for (let i = 0; i < 8; i++) starts.push(it.next().toUnixTime() * 1000);
		// 2026-10-27 is still summer time; 2026-11-03 is winter time (CET).
		expect(new Date(starts[1] as number).toISOString()).toBe('2026-10-27T17:00:00.000Z');
		expect(new Date(starts[2] as number).toISOString()).toBe('2026-11-03T17:00:00.000Z');
	});

	it('carries events from 90 days ago onward only', async () => {
		await create(admin.actor, { title: 'Old', date: '2026-06-01', startTime: '10:00' });
		await create(admin.actor, { title: 'Recent', date: '2026-08-01', startTime: '10:00' });
		await create(admin.actor, { title: 'Soon', date: '2026-10-08', startTime: '10:00' });
		const { text } = await fetchFeed((await feed(admin.actor, { scope: 'family' })).path);
		expect(vevents(text).map((e) => e.getFirstPropertyValue('summary'))).toEqual([
			'Recent',
			'Soon',
		]);
	});

	it('leaves out deleted events and records use at most hourly', async () => {
		const { path, feed: created } = await feed(admin.actor, { scope: 'family' });
		const e = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{ title: 'Gone', date: '2026-10-10', startTime: '10:00' },
			admin.actor,
		);
		if (e.status !== 'applied') throw new Error('expected applied');
		await k.runner.invoke('calendar.deleteEvent', { id: e.output.id }, admin.actor);
		expect(vevents((await fetchFeed(path)).text)).toHaveLength(0);
		const used = async () =>
			(
				await events(k.ctx.db)
					.selectFrom('calendar_feeds')
					.select('last_used_at')
					.where('id', '=', created.id)
					.executeTakeFirstOrThrow()
			).last_used_at;
		const first = k.clock.now();
		expect(await used()).toBe(first);
		k.clock.advance(30 * 60_000);
		await fetchFeed(path);
		expect(await used()).toBe(first);
		k.clock.advance(31 * 60_000);
		await fetchFeed(path);
		expect(await used()).toBe(k.clock.now());
	});
});

describe('RFC 5545 text', () => {
	it('escapes backslash, semicolon, comma and newlines', () => {
		expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
	});

	it('folds at 75 octets without splitting characters', () => {
		const line = `SUMMARY:${'Çğişö'.repeat(40)}`;
		const folded = foldLine(line);
		for (const part of folded.split('\r\n')) {
			expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
		}
		expect(folded.replace(/\r\n /g, '')).toBe(line);
		expect(foldLine('SHORT:line')).toBe('SHORT:line');
	});

	it('folds long titles in a real feed and parses back whole', async () => {
		const title =
			'Çok uzun bir etkinlik başlığı: şımarık çocukların öğretmenleri ile görüşme ve değerlendirme';
		await create(admin.actor, { title, date: '2026-10-10', startTime: '10:00' });
		const { text } = await fetchFeed((await feed(admin.actor, { scope: 'family' })).path);
		for (const line of text.split('\r\n'))
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		expect(vevents(text)[0]?.getFirstPropertyValue('summary')).toBe(title);
	});
});

describe('when a member’s sign-ins end', () => {
	it('stops their addresses from the queue, and only theirs', async () => {
		const mine = await feed(mum.actor, { scope: mum.member.id });
		const theirs = await feed(admin.actor, { scope: 'family' });
		await k.route('core.signOutEverywhere').call({ actor: mum.actor });
		// Nothing has run yet: the address works until the job does.
		await expect(fetchFeed(mine.path)).resolves.toBeDefined();
		await k.worker.drain();
		await expect(fetchFeed(mine.path)).rejects.toMatchObject({ code: 'not_found' });
		await expect(fetchFeed(theirs.path)).resolves.toBeDefined();
	});

	it('answers 404 at once for an archived owner, before any job runs, and records no use', async () => {
		const { path, feed: created } = await feed(mum.actor, { scope: mum.member.id });
		await k.runner.invoke('core.archiveMember', { memberId: mum.member.id }, admin.actor);
		await expect(fetchFeed(path)).rejects.toMatchObject({ code: 'not_found' });
		const row = await events(k.ctx.db)
			.selectFrom('calendar_feeds')
			.select('last_used_at')
			.where('id', '=', created.id)
			.executeTakeFirstOrThrow();
		expect(row.last_used_at).toBeNull();
	});
});
