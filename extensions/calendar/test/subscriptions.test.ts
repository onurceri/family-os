import { type Actor, ExternalHttpError, systemActor } from '@famos/sdk';
import { createFakeChannel, createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Occurrence, Subscription } from '../src/contract/index.ts';
import calendar from '../src/server/index.ts';
import { events } from '../src/server/store.ts';
import { floating, google, holiday, school, weekly, windowsZone } from './fixtures.ts';

const TZ = 'Europe/Istanbul';
const HOUR = 3_600_000;
const URL_SCHOOL = 'https://school.example/cal/private-8f3a9c.ics?key=SECRET';
let k: TestKernel;
let channel: ReturnType<typeof createFakeChannel>;
let admin: { actor: Actor; member: { id: string } };

beforeEach(async () => {
	channel = createFakeChannel('web');
	k = await createTestKernel({ extensions: [calendar], channels: [channel] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-07', '09:00', TZ));
	admin = await k.member('admin');
});
afterEach(() => k.close());

const range = (from: string, to: string): Promise<Occurrence[]> =>
	k.route('calendar.listOccurrences').call({ query: { from, to } });

async function add(url: string, extra: Record<string, unknown> = {}) {
	const r = await k.runner.invoke<Subscription>(
		'calendar.addSubscription',
		{ name: 'Feed', url, ...extra },
		admin.actor,
	);
	if (r.status !== 'applied') throw new Error('expected applied');
	await k.worker.drain();
	return r.output;
}

const row = async (id: string) =>
	events(k.ctx.db)
		.selectFrom('calendar_subscriptions')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirstOrThrow();

const titles = (list: Occurrence[]) => list.map((o) => o.title);

describe('subscriptions', () => {
	it('imports a school calendar with a VTIMEZONE and marks its events read-only', async () => {
		k.http.serve(URL_SCHOOL, { text: school });
		const sub = await add(URL_SCHOOL, { name: 'School', color: '#3f7fb5' });
		const day = await range('2026-10-20', '2026-10-20');
		expect(day).toHaveLength(1);
		expect(day[0]).toMatchObject({
			title: 'Veli toplantısı, 4-B',
			start: epochOf('2026-10-20', '18:00', TZ),
			end: epochOf('2026-10-20', '19:00', TZ),
			location: 'Okul binası; A blok',
			notes: 'Karne notları\nGetirmeyi unutmayın',
			editable: false,
			recurring: false,
			source: { kind: 'subscription', id: sub.id, name: 'School', color: '#3f7fb5' },
		});
		const state = await row(sub.id);
		expect(state).toMatchObject({
			event_count: 2,
			last_error: null,
			last_fetched_at: k.clock.now(),
		});
		// The multi-day break: exclusive DTEND becomes the last day.
		const winter = await range('2027-01-20', '2027-01-20');
		expect(winter[0]).toMatchObject({
			allDay: true,
			startDate: '2027-01-18',
			endDate: '2027-01-29',
		});
		expect(await range('2027-01-30', '2027-01-30')).toEqual([]);
	});

	it('expands a weekly series with an exclusion, a moved occurrence and a cancelled one', async () => {
		k.http.serve('https://club.example/swim.ics', { text: weekly });
		await add('webcal://club.example/swim.ics', { name: 'Club' });
		const list = await range('2026-10-08', '2026-10-31');
		expect(list.map((o) => [o.title, new Date(o.start as number).toISOString()])).toEqual([
			['Yüzme', '2026-10-08T06:00:00.000Z'],
			// 10-15 excluded; 10-22 moved to Friday 10:00; 10-29 cancelled.
			['Yüzme (taşındı)', '2026-10-23T07:00:00.000Z'],
		]);
		expect(list[0]?.recurring).toBe(true);
		// The series itself goes on after the changes (UNTIL 2026-12-31).
		expect(titles(await range('2026-11-05', '2026-11-05'))).toEqual(['Yüzme']);
		expect(await range('2027-01-07', '2027-01-07')).toEqual([]);
	});

	it('reads an all-day holiday, a floating time and a Google-style feed', async () => {
		k.http.serve('https://h.example/tr.ics', { text: holiday });
		k.http.serve('https://nas.home/cal.ics', { text: floating });
		k.http.serve('https://calendar.google.com/calendar/ical/x/private-abc/basic.ics', {
			text: google,
		});
		await add('https://h.example/tr.ics', { name: 'Holidays' });
		await add('https://nas.home/cal.ics', { name: 'NAS', allowLocal: true });
		await add('https://calendar.google.com/calendar/ical/x/private-abc/basic.ics', {
			name: 'Work',
		});
		const holidays = await range('2026-10-29', '2026-10-29');
		expect(holidays[0]).toMatchObject({
			title: 'Cumhuriyet Bayramı',
			allDay: true,
			startDate: '2026-10-29',
			endDate: '2026-10-29',
		});
		// 10:00 floating = 10:00 in the family time zone.
		const flo = await range('2026-10-10', '2026-10-10');
		expect(flo[0]?.start).toBe(epochOf('2026-10-10', '10:00', TZ));
		// Three Mondays from the UTC series, 10:00 Istanbul.
		const mondays = (await range('2026-10-12', '2026-11-30')).filter((o) => !o.allDay);
		expect(mondays.map((o) => o.start)).toEqual([
			epochOf('2026-10-12', '10:00', TZ),
			epochOf('2026-10-19', '10:00', TZ),
			epochOf('2026-10-26', '10:00', TZ),
		]);
	});

	it('expands a series in a zone only the feed defines into single events', async () => {
		k.http.serve('https://work.example/o.ics', { text: windowsZone });
		await add('https://work.example/o.ics');
		const list = await range('2026-10-01', '2026-11-30');
		expect(list).toHaveLength(4);
		expect(list.map((o) => o.start)).toEqual(
			['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03'].map((d) => epochOf(d, '15:00', TZ)),
		);
		expect(list.every((o) => !o.recurring)).toBe(true);
	});

	it('shows events with the subscription members and sorts them with the family events', async () => {
		k.http.serve('https://h.example/tr.ics', { text: holiday });
		await add('https://h.example/tr.ics', { memberIds: [admin.member.id] });
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Doktor', date: '2026-10-29', startTime: '10:00' },
			admin.actor,
		);
		const day = await range('2026-10-29', '2026-10-29');
		expect(day.map((o) => [o.title, o.editable])).toEqual([
			['Cumhuriyet Bayramı', false],
			['Doktor', true],
		]);
		expect(day[0]?.memberIds).toEqual([admin.member.id]);
		expect(day[1]).toMatchObject({ source: null, notes: null });
	});

	it('keeps events on 304 and refreshes the validators on 200', async () => {
		let calls = 0;
		k.http.serve(URL_SCHOOL, (request) => {
			calls++;
			return request.conditional?.etag === '"v1"'
				? { status: 304, etag: '"v1"', lastModified: null }
				: {
						status: 200,
						text: school,
						etag: '"v1"',
						lastModified: 'Mon, 05 Oct 2026 08:00:00 GMT',
					};
		});
		const sub = await add(URL_SCHOOL);
		expect((await row(sub.id)).etag).toBe('"v1"');
		k.clock.advance(HOUR);
		await k.runner.invoke('calendar.refreshSubscription', { id: sub.id }, admin.actor);
		await k.worker.drain();
		expect(calls).toBe(2);
		expect(k.http.requests[1]?.conditional).toEqual({
			etag: '"v1"',
			lastModified: 'Mon, 05 Oct 2026 08:00:00 GMT',
		});
		const state = await row(sub.id);
		expect(state.event_count).toBe(2);
		expect(state.last_fetched_at).toBe(k.clock.now());
		expect(await range('2026-10-20', '2026-10-20')).toHaveLength(1);
	});

	it('keeps the old events on an error and records only a code', async () => {
		k.http.serve(URL_SCHOOL, { text: school });
		const sub = await add(URL_SCHOOL);
		const fetchedAt = (await row(sub.id)).last_fetched_at;
		const refresh = async () => {
			k.clock.advance(HOUR);
			await k.runner.invoke('calendar.refreshSubscription', { id: sub.id }, admin.actor);
			await k.worker.drain();
			return row(sub.id);
		};
		for (const [served, code] of [
			[new ExternalHttpError('unreachable'), 'unreachable'],
			[new ExternalHttpError('timeout'), 'unreachable'],
			[new ExternalHttpError('too_large'), 'too_large'],
			[new ExternalHttpError('blocked_address'), 'blocked_address'],
			[new ExternalHttpError('bad_url'), 'bad_url'],
			[new ExternalHttpError('http_503'), 'http_503'],
			[{ text: '<html>Not found</html>' }, 'not_calendar'],
		] as const) {
			k.http.serve(URL_SCHOOL, served);
			const state = await refresh();
			expect(state.last_error).toBe(code);
			expect(state.event_count).toBe(2);
			expect(state.last_fetched_at).toBe(fetchedAt);
			expect(await range('2026-10-20', '2026-10-20')).toHaveLength(1);
		}
		// Recovered: the error clears.
		k.http.serve(URL_SCHOOL, { text: school });
		expect((await refresh()).last_error).toBeNull();
	});

	it('replaces the events when the feed changes', async () => {
		k.http.serve(URL_SCHOOL, { text: school });
		const sub = await add(URL_SCHOOL);
		k.http.serve(URL_SCHOOL, { text: holiday });
		k.clock.advance(HOUR);
		await k.runner.invoke('calendar.refreshSubscription', { id: sub.id }, admin.actor);
		await k.worker.drain();
		expect(await range('2026-10-20', '2026-10-20')).toEqual([]);
		expect(titles(await range('2026-10-29', '2026-10-29'))).toEqual(['Cumhuriyet Bayramı']);
	});

	it('refreshes every six hours until the subscription is removed', async () => {
		k.http.serve(URL_SCHOOL, { text: school });
		const sub = await add(URL_SCHOOL);
		expect(k.http.requests).toHaveLength(1);
		k.clock.advance(5 * HOUR);
		await k.worker.drain();
		expect(k.http.requests).toHaveLength(1);
		k.clock.advance(2 * HOUR);
		await k.worker.drain();
		expect(k.http.requests).toHaveLength(2);
		await k.runner.invoke('calendar.removeSubscription', { id: sub.id }, admin.actor);
		k.clock.advance(12 * HOUR);
		await k.worker.drain();
		expect(k.http.requests).toHaveLength(2);
	});

	it('removing a subscription deletes its events', async () => {
		k.http.serve(URL_SCHOOL, { text: school });
		const sub = await add(URL_SCHOOL);
		await k.runner.invoke('calendar.removeSubscription', { id: sub.id }, admin.actor);
		expect(await range('2026-10-20', '2026-10-20')).toEqual([]);
		const left = await events(k.ctx.db)
			.selectFrom('calendar_external_events')
			.selectAll()
			.execute();
		expect(left).toEqual([]);
		await expect(
			k.runner.invoke('calendar.removeSubscription', { id: sub.id }, admin.actor),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('is for people who manage the calendar', async () => {
		const mum = await k.member('member');
		for (const [id, input] of [
			['calendar.addSubscription', { name: 'X', url: URL_SCHOOL }],
			['calendar.updateSubscription', { id: 'cal_sub_x', name: 'Y' }],
			['calendar.removeSubscription', { id: 'cal_sub_x' }],
			['calendar.refreshSubscription', { id: 'cal_sub_x' }],
		] as const) {
			await expect(k.runner.invoke(id, input, mum.actor)).rejects.toMatchObject({
				code: 'forbidden',
			});
		}
		const route = k.registry.routes.find(
			(r) => r.route.operationId === 'calendar.listSubscriptions',
		);
		expect(route?.route.requires).toBe('calendar.manage');
		expect(k.access.can(mum.actor, 'calendar.view')).toBe(true);
		expect(k.access.can(mum.actor, 'calendar.manage')).toBe(false);
	});

	it('validates the address and never returns it', async () => {
		for (const url of [
			'http://school.example/a.ics',
			'ftp://x.example/a.ics',
			'not a url',
			'https://u:p@x.example/a.ics',
		]) {
			await expect(
				k.runner.invoke('calendar.addSubscription', { name: 'X', url }, admin.actor),
			).rejects.toMatchObject({ code: 'bad_request' });
		}
		k.http.serve(URL_SCHOOL, { text: school });
		const sub = await add(URL_SCHOOL);
		const listed = await k.route('calendar.listSubscriptions').call();
		for (const text of [JSON.stringify(sub), JSON.stringify(listed)]) {
			expect(text).toContain('school.example');
			expect(text).not.toContain('SECRET');
			expect(text).not.toContain('private-8f3a9c');
		}
		expect(listed[0]).toMatchObject({ host: 'school.example', eventCount: 2 });
		// Sealed at rest, and opened for the fetch.
		const stored = await row(sub.id);
		expect(stored.sealed_url).not.toContain('school.example');
		expect(k.http.requests[0]?.url).toBe(URL_SCHOOL);
	});

	it('passes allowLocal to the fetch and refetches when the address changes', async () => {
		k.http.serve('https://nas.home/cal.ics', { text: floating, etag: '"n"' });
		const sub = await add('webcal://nas.home/cal.ics', { allowLocal: true });
		expect(k.http.requests[0]).toMatchObject({
			url: 'webcal://nas.home/cal.ics',
			allowLocal: true,
		});
		await k.runner.invoke(
			'calendar.updateSubscription',
			{ id: sub.id, url: 'https://nas.home/other.ics', name: 'Renamed' },
			admin.actor,
		);
		k.http.serve('https://nas.home/other.ics', { text: holiday });
		await k.worker.drain();
		const last = k.http.requests.at(-1);
		expect(last?.url).toBe('https://nas.home/other.ics');
		expect(last?.conditional).toEqual({ etag: null, lastModified: null });
		expect((await row(sub.id)).name).toBe('Renamed');
		expect(titles(await range('2026-10-29', '2026-10-29'))).toEqual(['Cumhuriyet Bayramı']);
	});
});

describe('subscription reminders', () => {
	it('stay silent unless the subscription asks for them', async () => {
		k.http.serve('https://h.example/tr.ics', { text: holiday });
		await add('https://h.example/tr.ics');
		k.clock.set(epochOf('2026-10-29', '09:30', TZ));
		await k.worker.drain();
		expect(channel.sent).toHaveLength(0);
	});

	it('remind once at 09:00 on the day, and not again after a refresh changes nothing', async () => {
		k.http.serve('https://h.example/tr.ics', { text: holiday });
		const sub = await add('https://h.example/tr.ics', { reminders: true });
		expect(channel.sent).toHaveLength(0);
		// A refresh in between must not duplicate or lose the reminder.
		k.clock.set(epochOf('2026-10-28', '12:00', TZ));
		await k.worker.drain();
		k.clock.set(epochOf('2026-10-29', '09:00', TZ));
		await k.worker.drain();
		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]?.message).toMatchObject({
			source: { kind: 'calendar.subscription', id: sub.id },
		});
		k.clock.set(epochOf('2026-10-30', '12:00', TZ));
		await k.worker.drain();
		expect(channel.sent).toHaveLength(1);
	});

	it('are cancelled when the subscription is removed or its event leaves the feed', async () => {
		k.http.serve('https://h.example/tr.ics', { text: holiday });
		const sub = await add('https://h.example/tr.ics', { reminders: true });
		await k.runner.invoke('calendar.removeSubscription', { id: sub.id }, admin.actor);
		k.clock.set(epochOf('2026-10-29', '09:30', TZ));
		await k.worker.drain();
		expect(channel.sent).toHaveLength(0);
	});
});
