import { type Actor, defineNotificationKind, ExternalHttpError } from '@famos/sdk';
import { createTestKernel, defineTestExtension, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyTargets, PersonLink } from '../src/contract/index.ts';
import homeassistant from '../src/server/index.ts';
import { notifyServicesOf, orderTargets, trackersOf } from '../src/server/notify.ts';
import { connectHomeAssistant } from './connect.ts';

const BASE = 'http://192.168.1.20:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sentinel-payload.sentinel-signature';
const PHONE = 'mobile_app_alex_phone';
const SEND = `${BASE}/api/services/notify/${PHONE}`;

const ping = defineNotificationKind({ id: 'hub.ping', label: 'hub:kind_ping' });
const hub = defineTestExtension({ id: 'hub', notifications: [ping] });

/** The languages texts were asked for. */
let asked: string[] = [];
let k: TestKernel;
let admin: Actor & { kind: 'member' };
let alex: Actor & { kind: 'member' };
let sam: Actor & { kind: 'member' };

async function start(publicUrl?: string) {
	asked = [];
	k = await createTestKernel({
		extensions: [homeassistant, hub],
		translate: (locale, key) => {
			asked.push(locale);
			return key;
		},
		...(publicUrl && { publicUrl }),
	});
	admin = (await k.member('admin', 'Deniz')).actor;
	alex = (await k.member('member', 'Alex')).actor;
	sam = (await k.member('supervised', 'Sam')).actor;
}
beforeEach(() => start());
afterEach(() => k.close());

const services = (names: string[], extra: Record<string, unknown> = {}) =>
	JSON.stringify([
		{ domain: 'light', services: { turn_on: {}, turn_off: {} } },
		{ domain: 'notify', services: Object.fromEntries(names.map((n) => [n, {}])) },
		...Object.entries(extra).map(([domain, s]) => ({ domain, services: s })),
	]);
const person = (id: string, trackers: string[]) =>
	JSON.stringify({
		entity_id: id,
		state: 'home',
		attributes: {
			latitude: 52.3601,
			longitude: 4.8866,
			gps_accuracy: 12,
			device_trackers: trackers,
			friendly_name: id.slice(7),
		},
	});

async function connect() {
	await connectHomeAssistant(k, admin, BASE, TOKEN);
	await k.worker.drain();
}
const link = (memberId = alex.memberId, personEntity = 'person.alex') =>
	k.runner.invoke<PersonLink>('homeassistant.linkPerson', { memberId, personEntity }, admin);
const target = (service: string | null, memberId = alex.memberId, who: Actor = admin) =>
	k.runner.invoke<PersonLink>('homeassistant.setNotifyTarget', { memberId, service }, who);
const test = (memberId = alex.memberId, who: Actor = admin) =>
	k.runner.invoke('homeassistant.testNotify', { memberId }, who);
const links = async (): Promise<PersonLink[]> =>
	(await k.route('homeassistant.listPeople').call({ actor: admin })).links;
const targets = (memberId?: string, who: Actor = admin): Promise<NotifyTargets> =>
	k
		.route('homeassistant.listNotifyTargets')
		.call({ actor: who, query: memberId ? { memberId } : {} });

async function ready() {
	await connect();
	await link();
	await target(PHONE);
}
/** Alex turns the channel on for the kind, and the kind happens. */
async function turnOn(who: Actor = alex) {
	await k.runner.invoke(
		'core.setNotificationPreferences',
		{ kinds: { 'hub.ping': { homeassistant: true } }, quietHours: null },
		who,
	);
}
const happen = (memberId = alex.memberId, extra: { url?: string } = {}) =>
	k.ctx.notify({
		kind: 'hub.ping',
		to: { members: [memberId] },
		title: { key: 'hub:title' },
		body: { key: 'hub:body' },
		...extra,
	});
const sent = () => k.http.posted.filter((p) => p.url === SEND);
const preferences = () => k.route('core.getNotificationPreferences').call({ actor: alex });

/** What the logger was told while `work` ran. */
async function logged(work: () => Promise<void>): Promise<string> {
	const lines: unknown[] = [];
	const ctx = k.contextFor('homeassistant');
	const original = ctx.logger.info;
	// biome-ignore lint/suspicious/noExplicitAny: a spy over the logger's overloads.
	(ctx.logger as any).info = (...args: unknown[]) => void lines.push(args);
	try {
		await work();
	} finally {
		// biome-ignore lint/suspicious/noExplicitAny: restoring the spy.
		(ctx.logger as any).info = original;
	}
	return JSON.stringify(lines);
}

describe('reading Home Assistant', () => {
	it('keeps the names of the notify services and nothing else', () => {
		expect(
			notifyServicesOf(
				JSON.parse(services(['mobile_app_b', 'notify', 'bad name', 'Upper', '../x'])),
			),
		).toEqual(['mobile_app_b', 'notify']);
		expect(notifyServicesOf({})).toEqual([]);
		expect(notifyServicesOf([{ domain: 'light', services: { turn_on: {} } }])).toEqual([]);
	});

	it('keeps only the ids of the trackers of a person', () => {
		expect(
			trackersOf({ attributes: { device_trackers: ['device_tracker.alex_phone', 'sensor.x', 5] } }),
		).toEqual(['device_tracker.alex_phone']);
		expect(trackersOf(null)).toEqual([]);
		expect(trackersOf({ attributes: { device_trackers: 'x' } })).toEqual([]);
	});

	it("orders the person's own phone first, then the other phones, then the rest", () => {
		const ordered = orderTargets(
			['mobile_app_sam_tablet', 'notify', 'mobile_app_alex_phone', 'persistent_notification'],
			['device_tracker.alex_phone'],
		);
		expect(ordered).toEqual([
			{ service: 'mobile_app_alex_phone', suggested: true },
			{ service: 'mobile_app_sam_tablet', suggested: false },
			{ service: 'notify', suggested: false },
			{ service: 'persistent_notification', suggested: false },
		]);
	});
});

describe('the list of targets', () => {
	beforeEach(async () => {
		await connect();
		await link();
		k.http.serve(`${BASE}/api/services`, {
			text: services(['notify', 'mobile_app_sam_tablet', PHONE, 'persistent_notification']),
		});
		k.http.serve(`${BASE}/api/states/person.alex`, {
			text: person('person.alex', ['device_tracker.alex_phone']),
		});
	});

	it('suggests the phone of the linked person and lists the rest after it', async () => {
		const found = await targets(alex.memberId);
		expect(found.status).toBe('ok');
		expect(found.targets.map((t) => [t.service, t.suggested])).toEqual([
			[PHONE, true],
			['mobile_app_sam_tablet', false],
			['notify', false],
			['persistent_notification', false],
		]);
		// Nothing of the person but the id of the tracker reached the answer.
		expect(JSON.stringify(found)).not.toContain('52.36');
	});

	it('lists without a suggestion for a member who is not linked, or none', async () => {
		expect((await targets(sam.memberId)).targets.some((t) => t.suggested)).toBe(false);
		expect((await targets()).targets[0]?.service).toBe(PHONE);
	});

	it('is for those who manage Home Assistant, and keeps the answer for a minute', async () => {
		const route = k.registry.routes.find(
			(r) => r.route.operationId === 'homeassistant.listNotifyTargets',
		);
		expect(route?.route.requires).toBe('homeassistant.manage');
		expect(k.access.can(alex, 'homeassistant.manage')).toBe(false);
		const count = () => k.http.requests.filter((r) => r.url === `${BASE}/api/services`).length;
		await targets();
		await targets();
		expect(count()).toBe(1);
		k.clock.advance(61_000);
		await targets();
		expect(count()).toBe(2);
	});

	it('asks with a short timeout and a size cap, as the other reads do', async () => {
		await targets();
		const call = k.http.requests.find((r) => r.url === `${BASE}/api/services`);
		expect(call).toMatchObject({ allowLocal: true });
		expect(call?.timeoutMs).toBeLessThanOrEqual(15_000);
		expect(call?.maxBytes).toBeGreaterThan(0);
	});

	it('says unavailable when Home Assistant does not answer, and asks again next time', async () => {
		k.http.serve(`${BASE}/api/services`, new ExternalHttpError('timeout'));
		expect(await targets()).toEqual({ targets: [], status: 'unavailable' });
		k.http.serve(`${BASE}/api/services`, { text: services([PHONE]) });
		expect((await targets()).status).toBe('ok');
	});

	it('says not connected without a connection', async () => {
		await k.runner.invoke('homeassistant.disconnect', {}, admin);
		expect(await targets()).toEqual({ targets: [], status: 'not_connected' });
	});
});

describe('choosing the phone', () => {
	beforeEach(async () => {
		await connect();
		await link();
	});

	it('is for those who manage Home Assistant', async () => {
		await expect(target(PHONE, alex.memberId, alex)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(target(PHONE, alex.memberId, sam)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(test(alex.memberId, alex)).rejects.toMatchObject({ code: 'forbidden' });
		expect((await links())[0]?.notifyService).toBeNull();
	});

	it('is kept on the link, and chosen again or cleared', async () => {
		expect(await target(PHONE)).toMatchObject({
			status: 'applied',
			output: { notifyService: PHONE, notifyStatus: null },
		});
		expect((await links())[0]).toMatchObject({ notifyService: PHONE });
		await target(null);
		expect((await links())[0]).toMatchObject({ notifyService: null, notifyStatus: null });
	});

	it('takes one word of the notify services and nothing that could change the address', async () => {
		for (const service of ['a/b', '../config', 'notify.mobile', 'Upper', '', 'a b', 'x?y'])
			await expect(target(service)).rejects.toBeTruthy();
	});

	it('needs a member who is linked', async () => {
		await expect(target(PHONE, sam.memberId)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('forgets how the last text went when the phone is another one', async () => {
		await target(PHONE);
		k.http.servePost(SEND, {});
		await test();
		await k.worker.drain();
		expect((await links())[0]?.notifyStatus).toBe('ok');
		await target(PHONE);
		expect((await links())[0]?.notifyStatus).toBe('ok');
		await target('mobile_app_new_phone');
		expect((await links())[0]?.notifyStatus).toBeNull();
	});

	it('is cleared when the member is unlinked, and when they become another person', async () => {
		await target(PHONE);
		await k.runner.invoke('homeassistant.unlinkPerson', { memberId: alex.memberId }, admin);
		await link();
		expect((await links())[0]).toMatchObject({ notifyService: null });
		await target(PHONE);
		await link(alex.memberId, 'person.alex_two');
		expect((await links())[0]).toMatchObject({ notifyService: null, notifyStatus: null });
		// Linked to the same person again changes nothing.
		await target(PHONE);
		await link(alex.memberId, 'person.alex_two');
		expect((await links())[0]).toMatchObject({ notifyService: PHONE });
	});

	it('cannot be suggested by the AI', async () => {
		for (const id of ['homeassistant.setNotifyTarget', 'homeassistant.testNotify'])
			expect(k.registry.actions.get(id)?.ai).toBeUndefined();
		await target(PHONE);
		await expect(
			k.runner.invoke(
				'homeassistant.testNotify',
				{ memberId: alex.memberId },
				{ kind: 'ai', mode: 'agent', source: 'assistant', onBehalfOf: admin.memberId },
			),
		).rejects.toBeTruthy();
	});
});

describe('send a test', () => {
	beforeEach(async () => {
		await ready();
	});

	it('needs a phone', async () => {
		await target(null);
		await expect(test()).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('sends a short translated text to the chosen service and says it arrived', async () => {
		k.http.servePost(SEND, {});
		await test();
		await k.worker.drain();
		expect(sent()).toHaveLength(1);
		expect(sent()[0]?.json).toMatchObject({
			title: expect.stringContaining('homeassistant:notify_test_title'),
			message: expect.stringContaining('homeassistant:notify_test_body'),
			data: { group: 'familyos' },
		});
		expect((await links())[0]?.notifyStatus).toBe('ok');
	});

	it('says the phone is gone when Home Assistant answers 400', async () => {
		k.http.servePost(SEND, new ExternalHttpError('http_400'));
		await test();
		await k.worker.drain();
		expect((await links())[0]?.notifyStatus).toBe('missing');
	});

	it('says the token was refused, and the connection says so as well', async () => {
		for (const code of ['http_401', 'http_403'] as const) {
			k.http.servePost(SEND, new ExternalHttpError(code));
			await test();
			await k.worker.drain();
			expect((await links())[0]?.notifyStatus).toBe('refused');
			const connection = await k.route('homeassistant.getConnection').call({ actor: admin });
			expect(connection).toMatchObject({ status: 'token_refused' });
			k.clock.advance(5_000);
		}
	});

	it('says Home Assistant could not be reached on a timeout, unreachable or a 5xx', async () => {
		for (const code of ['timeout', 'unreachable', 'http_502'] as const) {
			k.http.servePost(SEND, new ExternalHttpError(code));
			await test();
			await k.worker.drain();
			expect((await links())[0]?.notifyStatus).toBe('unreachable');
			k.clock.advance(5_000);
		}
	});

	it('writes the text in the language of the member', async () => {
		k.http.servePost(SEND, {});
		await test();
		await k.worker.drain();
		const settings = await k.ctx.family.settings();
		expect(asked).toContain(settings.locale);
	});

	it('is one test for taps in quick succession', async () => {
		k.http.servePost(SEND, {});
		await test();
		await test();
		await k.worker.drain();
		expect(sent()).toHaveLength(1);
	});
});

describe('the channel', () => {
	it('is off until the member turns it on, and a hint tells who cannot be reached', async () => {
		await connect();
		await link();
		let mine = await preferences();
		const channel = () => mine.channels.find((c: { id: string }) => c.id === 'homeassistant');
		// Linked but no phone chosen yet: shown unavailable, with the hint.
		expect(channel()).toMatchObject({ available: false, hint: 'homeassistant:channel_hint' });
		await target(PHONE);
		mine = await preferences();
		expect(channel()).toEqual({
			id: 'homeassistant',
			label: 'homeassistant:channel_label',
			available: true,
		});
		// No kind names the channel, and it is off by default: nothing is on until the member says.
		expect(mine.kinds.find((x: { id: string }) => x.id === 'hub.ping').defaultChannels).toEqual([]);

		k.http.servePost(SEND, {});
		await happen();
		await k.worker.drain();
		expect(sent()).toEqual([]);

		await turnOn();
		await happen();
		await k.worker.drain();
		expect(sent()).toHaveLength(1);
	});

	it('is unavailable without a link, without a phone, and with a refused token', async () => {
		await connect();
		const channel = async (who: Actor) =>
			(await k.route('core.getNotificationPreferences').call({ actor: who })).channels.find(
				(c: { id: string }) => c.id === 'homeassistant',
			);
		expect(await channel(alex)).toMatchObject({ available: false });
		await link();
		expect(await channel(alex)).toMatchObject({ available: false });
		await target(PHONE);
		expect(await channel(alex)).toMatchObject({ available: true });
		// A member who is not linked stays unavailable although another one is.
		expect(await channel(sam)).toMatchObject({ available: false });
		k.http.servePost(SEND, new ExternalHttpError('http_401'));
		await turnOn();
		await happen();
		await k.worker.drain();
		expect(await channel(alex)).toMatchObject({ available: false });
	});

	it('sends the title, the text and the tag, with a link only when the family set its address', async () => {
		await ready();
		await turnOn();
		k.http.servePost(SEND, {});
		await happen(alex.memberId, { url: '/today' });
		await k.worker.drain();
		expect(sent()).toHaveLength(1);
		const body = sent()[0]?.json as {
			title: string;
			message: string;
			data: Record<string, unknown>;
		};
		expect(body.title).toContain('hub:title');
		expect(body.message).toContain('hub:body');
		expect(body.data).toMatchObject({ group: 'familyos', tag: expect.any(String) });
		expect(body.data).not.toHaveProperty('url');
		expect(body.data).not.toHaveProperty('clickAction');
		expect(sent()[0]?.headers).not.toHaveProperty('authorization');

		await k.close();
		await start('https://home.example');
		await ready();
		await turnOn();
		k.http.servePost(SEND, {});
		await happen(alex.memberId, { url: '/today' });
		await k.worker.drain();
		expect(sent()[0]?.json).toMatchObject({
			data: { url: 'https://home.example/today', clickAction: 'https://home.example/today' },
		});
	});

	it('uses the title as the text when there is no body', async () => {
		await ready();
		await turnOn();
		k.http.servePost(SEND, {});
		await k.ctx.notify({
			kind: 'hub.ping',
			to: { members: [alex.memberId] },
			title: { key: 'hub:title' },
		});
		await k.worker.drain();
		const body = sent()[0]?.json as { title: string; message: string };
		expect(body.message).toBe(body.title);
	});

	it('marks the phone as working after the first text, once', async () => {
		await ready();
		await turnOn();
		k.http.servePost(SEND, {});
		await happen();
		await k.worker.drain();
		expect((await links())[0]?.notifyStatus).toBe('ok');
	});

	it('drops the text and shows the phone as missing when Home Assistant answers 400', async () => {
		await ready();
		await turnOn();
		k.http.servePost(SEND, new ExternalHttpError('http_400'));
		await happen();
		await k.worker.drain();
		expect(sent()).toHaveLength(1);
		expect((await links())[0]?.notifyStatus).toBe('missing');
	});

	it('drops the text and records a refused token on 401 and 403', async () => {
		for (const code of ['http_401', 'http_403'] as const) {
			await k.close();
			await start();
			await ready();
			await turnOn();
			k.http.servePost(SEND, new ExternalHttpError(code));
			await happen();
			await k.worker.drain();
			expect(sent()).toHaveLength(1);
			const connection = await k.route('homeassistant.getConnection').call({ actor: admin });
			expect(connection).toMatchObject({ status: 'token_refused' });
		}
	});

	it('tries again on a timeout, unreachable or a 5xx', async () => {
		await ready();
		await turnOn();
		for (const code of ['timeout', 'unreachable', 'http_503'] as const) {
			const before = sent().length;
			k.http.servePost(SEND, new ExternalHttpError(code));
			await happen();
			await k.worker.drain();
			expect(sent().length).toBeGreaterThan(before);
			// Home Assistant has come back: the next try lands.
			k.http.servePost(SEND, {});
			k.clock.advance(10 * 60_000);
			await k.worker.drain();
		}
		expect((await links())[0]?.notifyStatus).toBe('ok');
	});

	it('waits out quiet hours like every channel', async () => {
		await ready();
		await k.runner.invoke(
			'core.setNotificationPreferences',
			{
				kinds: { 'hub.ping': { homeassistant: true } },
				quietHours: { start: '00:00', end: '23:59' },
			},
			alex,
		);
		k.http.servePost(SEND, {});
		await happen();
		await k.worker.drain();
		expect(sent()).toEqual([]);
	});

	it('sends nothing to a member who did not turn it on, although another one did', async () => {
		await connect();
		await link();
		await link(sam.memberId, 'person.sam');
		await target(PHONE);
		await target(PHONE.replace('alex', 'sam'), sam.memberId);
		await turnOn(alex);
		k.http.servePost(SEND, {});
		k.http.servePost(`${BASE}/api/services/notify/mobile_app_sam_phone`, {});
		await happen(alex.memberId);
		await happen(sam.memberId);
		await k.worker.drain();
		expect(sent()).toHaveLength(1);
		expect(k.http.posted.filter((p) => p.url.endsWith('mobile_app_sam_phone'))).toEqual([]);
	});

	it('logs only the outcome: never the text, the address or the service', async () => {
		await ready();
		await turnOn();
		const text = await logged(async () => {
			k.http.servePost(SEND, new ExternalHttpError('http_400'));
			await happen();
			await k.worker.drain();
			k.http.servePost(SEND, {});
			await test();
			await k.worker.drain();
		});
		expect(text).toContain('http_400');
		for (const secret of [TOKEN, '192.168.1.20', PHONE, 'alex_phone', 'hub:title', 'notify_test'])
			expect(text).not.toContain(secret);
	});
});
