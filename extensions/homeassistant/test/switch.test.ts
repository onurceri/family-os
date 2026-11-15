import { type Actor, ExternalHttpError } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CONTROLS,
	type Connection,
	type Item,
	OPERATIONS,
	operationsOf,
	serviceFor,
	type Values,
} from '../src/contract/index.ts';
import homeassistant from '../src/server/index.ts';
import { connectHomeAssistant } from './connect.ts';

const BASE = 'http://192.168.1.20:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sentinel-payload.sentinel-signature';

let k: TestKernel;
let admin: Actor & { kind: 'member' };
let alex: Actor & { kind: 'member' };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [homeassistant] });
	admin = (await k.member('admin', 'Deniz')).actor;
	alex = (await k.member('member', 'Alex')).actor;
});
afterEach(() => k.close());

const display: Actor = {
	kind: 'display',
	deviceId: 'dev',
	capabilities: ['homeassistant.view', 'homeassistant.control'],
	showNames: true,
};

const state = (entityId: string, value: string) =>
	JSON.stringify({
		entity_id: entityId,
		state: value,
		attributes: { friendly_name: entityId },
		last_changed: '2026-10-17T08:30:00+00:00',
	});

async function connect() {
	await connectHomeAssistant(k, admin, BASE, TOKEN);
	// The check runs (and finds nothing at the fake address) before anything is switched.
	await k.worker.drain();
}
async function add(entityId: string, label = entityId): Promise<Item> {
	const r = await k.runner.invoke<Item>('homeassistant.addItem', { entityId, label }, admin);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output;
}
const allow = (id: string, control = true, confirm = true, who: Actor = admin) =>
	k.runner.invoke<Item>('homeassistant.setItemControl', { id, control, confirm }, who);
const flip = (id: string, operation: string, who: Actor = admin) =>
	k.runner.invoke('homeassistant.switch', { id, operation }, who);
const jobs = async () =>
	(
		await sql<{ name: string; status: string }>`select name, status from queue_jobs
			where name = 'homeassistant.switch'`.execute(k.ctx.db)
	).rows;
const values = (): Promise<Values> => k.route('homeassistant.getValues').call({ actor: admin });
const connection = (): Promise<Connection> =>
	k.route('homeassistant.getConnection').call({ actor: admin });

describe('what may be switched', () => {
	it('is a table of services per domain, and nothing else', () => {
		expect(Object.keys(CONTROLS).sort()).toEqual(
			[
				'button',
				'cover',
				'fan',
				'humidifier',
				'input_boolean',
				'input_button',
				'light',
				'lock',
				'media_player',
				'scene',
				'script',
				'switch',
				'vacuum',
				'valve',
			].sort(),
		);
		expect(operationsOf('light.kitchen')).toEqual(['turn_on', 'turn_off']);
		expect(operationsOf('cover.garage')).toEqual(['open_cover', 'close_cover', 'stop_cover']);
		expect(operationsOf('lock.front_door')).toEqual(['lock', 'unlock']);
		expect(operationsOf('scene.evening')).toEqual(['turn_on']);
		expect(operationsOf('button.doorbell')).toEqual(['press']);
		expect(operationsOf('input_button.bell')).toEqual(['press']);
		expect(operationsOf('valve.garden')).toEqual(['open_valve', 'close_valve', 'stop_valve']);
		expect(operationsOf('vacuum.robot')).toEqual(['start', 'pause', 'return_to_base']);
		expect(operationsOf('media_player.tv')).toEqual([
			'media_play',
			'media_pause',
			'turn_on',
			'turn_off',
		]);
		for (const id of ['sensor.x', 'climate.living', 'alarm_control_panel.home', 'constructor.x'])
			expect(operationsOf(id)).toEqual([]);
	});

	it('never takes a service from the input', () => {
		expect(serviceFor('light.kitchen', 'turn_on')).toEqual({ domain: 'light', service: 'turn_on' });
		for (const operation of ['../config', 'turn_on/../../config', 'unlock', 'toString', ''])
			expect(serviceFor('light.kitchen', operation)).toBeNull();
		expect(serviceFor('lock.front_door', 'turn_on')).toBeNull();
		expect(serviceFor('climate.living', 'turn_on')).toBeNull();
		expect(serviceFor('light.kitchen', 'press')).toBeNull();
		expect(serviceFor('media_player.tv', 'start')).toBeNull();
		expect(serviceFor('vacuum.robot', 'turn_on')).toBeNull();
		expect(serviceFor('valve.garden', 'open_cover')).toBeNull();
		expect(serviceFor('__proto__.x', 'turn_on')).toBeNull();
	});
});

describe('setItemControl', () => {
	it('starts off and not asking (the family decides), and is for those who manage Home Assistant only', async () => {
		const light = await add('light.ceiling_lights', 'Ceiling');
		expect(light).toMatchObject({ control: false, confirm: false });
		await expect(allow(light.id, true, true, alex)).rejects.toMatchObject({ code: 'forbidden' });
		expect(await allow(light.id, true, false)).toMatchObject({
			status: 'applied',
			output: { control: true, confirm: false },
		});
		const listed = (await k.route('homeassistant.listItems').call({ actor: admin })).items;
		expect(listed[0]).toMatchObject({ control: true, confirm: false });
	});

	it('refuses switching for a thing FamilyOS cannot switch', async () => {
		const sensor = await add('sensor.outside_temperature');
		const climate = await add('climate.hvac');
		for (const item of [sensor, climate])
			await expect(allow(item.id)).rejects.toMatchObject({ code: 'bad_request' });
		// Asking first can still be chosen; it changes nothing while switching is off.
		expect(await allow(sensor.id, false, false)).toMatchObject({ output: { control: false } });
	});

	it('cannot be run or suggested by the AI', async () => {
		const light = await add('light.ceiling_lights');
		for (const mode of ['conversation', 'share', 'agent'] as const)
			await expect(
				allow(light.id, true, true, {
					kind: 'ai',
					mode,
					source: 'assistant',
					onBehalfOf: admin.memberId,
				}),
			).rejects.toBeTruthy();
		expect(await k.route('core.listDrafts').call({ actor: admin, query: { limit: 50 } })).toEqual(
			[],
		);
		expect(k.registry.actions.get('homeassistant.setItemControl')?.ai).toBeUndefined();
	});
});

describe('switch', () => {
	let light: Item;
	beforeEach(async () => {
		await connect();
		light = await add('light.ceiling_lights', 'Ceiling');
	});

	it('is for people who hold the permission, admins at first', async () => {
		await allow(light.id);
		expect(k.access.can(admin, 'homeassistant.control')).toBe(true);
		expect(k.access.can(alex, 'homeassistant.control')).toBe(false);
		await expect(flip(light.id, 'turn_on', alex)).rejects.toMatchObject({ code: 'forbidden' });
		expect(await jobs()).toEqual([]);
	});

	it('refuses an item the family did not allow, and an operation its domain does not have', async () => {
		await expect(flip(light.id, 'turn_on')).rejects.toMatchObject({ code: 'forbidden' });
		await allow(light.id);
		await expect(flip(light.id, 'unlock')).rejects.toMatchObject({ code: 'bad_request' });
		await expect(flip(light.id, 'press')).rejects.toMatchObject({ code: 'bad_request' });
		const player = await add('media_player.tv', 'TV');
		await allow(player.id);
		await expect(flip(player.id, 'start')).rejects.toMatchObject({ code: 'bad_request' });
		await expect(flip(player.id, 'open_valve')).rejects.toMatchObject({ code: 'bad_request' });
		await expect(flip(light.id, '../config')).rejects.toMatchObject({ code: 'bad_request' });
		await expect(flip('ha_item_missing', 'turn_on')).rejects.toMatchObject({ code: 'not_found' });
		expect(await jobs()).toEqual([]);
	});

	it('enqueues one job, and a double tap is still one', async () => {
		await allow(light.id);
		expect(await flip(light.id, 'turn_on')).toMatchObject({ status: 'applied' });
		await flip(light.id, 'turn_on');
		expect(await jobs()).toEqual([{ name: 'homeassistant.switch', status: 'pending' }]);
		// Nothing is sent before the job runs.
		expect(k.http.posted).toEqual([]);
	});

	it('can never be run or suggested by the AI, nor by a display', async () => {
		await allow(light.id);
		for (const mode of ['conversation', 'share', 'agent'] as const) {
			await expect(
				flip(light.id, 'turn_on', {
					kind: 'ai',
					mode,
					source: 'assistant',
					onBehalfOf: admin.memberId,
				}),
			).rejects.toBeTruthy();
			await expect(
				flip(light.id, 'turn_on', { kind: 'ai', mode, source: 'mcp' }),
			).rejects.toBeTruthy();
		}
		await expect(flip(light.id, 'turn_on', display)).rejects.toMatchObject({ code: 'forbidden' });
		expect(await jobs()).toEqual([]);
		expect(await k.route('core.listDrafts').call({ actor: admin, query: { limit: 50 } })).toEqual(
			[],
		);
		expect(k.registry.actions.get('homeassistant.switch')?.ai).toBeUndefined();
	});
});

describe('the switch job', () => {
	let light: Item;
	const failures: { memberId: string; name: string; payload: unknown }[] = [];
	const events: string[] = [];
	beforeEach(async () => {
		failures.length = 0;
		events.length = 0;
		k.bus.onMember((memberId, name, payload) => void failures.push({ memberId, name, payload }));
		k.bus.onAny((name) => void events.push(name));
		await connect();
		light = await add('light.ceiling_lights', 'Ceiling');
		await allow(light.id);
	});

	it('calls exactly the service for the operation, with the entity and the token', async () => {
		k.http.servePost(`${BASE}/api/services/light/turn_on`, { text: '[]' });
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect(k.http.posted).toEqual([
			{
				url: `${BASE}/api/services/light/turn_on`,
				json: { entity_id: 'light.ceiling_lights' },
				headers: { accept: 'application/json' },
			},
		]);
		expect(failures).toEqual([]);
		expect(events).toContain('homeassistant.values.changed');
	});

	it.each([
		['cover.kitchen_window', 'open_cover', '/api/services/cover/open_cover'],
		['cover.kitchen_window', 'stop_cover', '/api/services/cover/stop_cover'],
		['lock.front_door', 'unlock', '/api/services/lock/unlock'],
		['scene.evening', 'turn_on', '/api/services/scene/turn_on'],
		['script.bedtime', 'turn_on', '/api/services/script/turn_on'],
		['input_boolean.guests', 'turn_off', '/api/services/input_boolean/turn_off'],
		['fan.winix_play_room', 'turn_on', '/api/services/fan/turn_on'],
		['fan.winix_play_room', 'turn_off', '/api/services/fan/turn_off'],
		['humidifier.dehumidifier', 'turn_on', '/api/services/humidifier/turn_on'],
		['humidifier.dehumidifier', 'turn_off', '/api/services/humidifier/turn_off'],
		['button.doorbell', 'press', '/api/services/button/press'],
		['input_button.bell', 'press', '/api/services/input_button/press'],
		['valve.garden', 'open_valve', '/api/services/valve/open_valve'],
		['valve.garden', 'close_valve', '/api/services/valve/close_valve'],
		['valve.garden', 'stop_valve', '/api/services/valve/stop_valve'],
		['vacuum.robot', 'start', '/api/services/vacuum/start'],
		['vacuum.robot', 'pause', '/api/services/vacuum/pause'],
		['vacuum.robot', 'return_to_base', '/api/services/vacuum/return_to_base'],
		['media_player.tv', 'media_play', '/api/services/media_player/media_play'],
		['media_player.tv', 'media_pause', '/api/services/media_player/media_pause'],
		['media_player.tv', 'turn_on', '/api/services/media_player/turn_on'],
		['media_player.tv', 'turn_off', '/api/services/media_player/turn_off'],
	])('%s %s posts to %s', async (entityId, operation, path) => {
		const item = await add(entityId);
		await allow(item.id);
		k.http.servePost(`${BASE}${path}`, {});
		await flip(item.id, operation);
		await k.worker.drain();
		expect(k.http.posted.map((p) => [p.url, p.json])).toEqual([
			[`${BASE}${path}`, { entity_id: entityId }],
		]);
	});

	describe('a fan speed', () => {
		const flipSpeed = (id: string, extra: Record<string, unknown>, operation = 'set_percentage') =>
			k.runner.invoke('homeassistant.switch', { id, operation, ...extra }, admin);
		let fan: Item;
		beforeEach(async () => {
			fan = await add('fan.winix_play_room', 'Air purifier');
			await allow(fan.id);
		});

		it('posts the percentage and nothing else', async () => {
			k.http.servePost(`${BASE}/api/services/fan/set_percentage`, {});
			await flipSpeed(fan.id, { percentage: 25, level: 1 });
			await k.worker.drain();
			expect(k.http.posted.map((p) => [p.url, p.json])).toEqual([
				[
					`${BASE}/api/services/fan/set_percentage`,
					{ entity_id: 'fan.winix_play_room', percentage: 25 },
				],
			]);
			const history = await sql<{ operation: string; level: number | null; ok: number }>`
				select operation, level, ok from homeassistant_switches`.execute(k.ctx.db);
			expect(history.rows).toEqual([{ operation: 'set_percentage', level: 1, ok: 1 }]);
		});

		it('keeps two speeds apart, and turn_on and turn_off carry only the entity', async () => {
			k.http.servePost(`${BASE}/api/services/fan/set_percentage`, {});
			k.http.servePost(`${BASE}/api/services/fan/turn_off`, {});
			await flipSpeed(fan.id, { percentage: 25, level: 1 });
			await flipSpeed(fan.id, { percentage: 50, level: 2 });
			await k.worker.drain();
			expect(k.http.posted.map((p) => p.json)).toEqual([
				{ entity_id: 'fan.winix_play_room', percentage: 25 },
				{ entity_id: 'fan.winix_play_room', percentage: 50 },
			]);
			await flipSpeed(fan.id, {}, 'turn_off');
			await k.worker.drain();
			expect(k.http.posted.at(-1)?.json).toEqual({ entity_id: 'fan.winix_play_room' });
		});

		it.each([
			['none', {}],
			['negative', { percentage: -1, level: 1 }],
			['over 100', { percentage: 101, level: 1 }],
			['not whole', { percentage: 12.5, level: 1 }],
			['text', { percentage: '50', level: 1 }],
			['no level', { percentage: 50 }],
			['level 0', { percentage: 50, level: 0 }],
		])('refuses a speed that is %s, and sends nothing', async (_name, extra) => {
			await expect(flipSpeed(fan.id, extra)).rejects.toMatchObject({ code: 'bad_request' });
			expect(await jobs()).toEqual([]);
			expect(k.http.posted).toEqual([]);
		});

		it('refuses a percentage for any other operation, or for another domain', async () => {
			await expect(flipSpeed(fan.id, { percentage: 50 }, 'turn_on')).rejects.toMatchObject({
				code: 'bad_request',
			});
			await expect(
				flipSpeed(fan.id, { percentage: 50, level: 2 }, 'turn_off'),
			).rejects.toMatchObject({ code: 'bad_request' });
			await expect(flipSpeed(light.id, { percentage: 50, level: 2 })).rejects.toMatchObject({
				code: 'bad_request',
			});
			await expect(flipSpeed(light.id, { percentage: 50 }, 'turn_on')).rejects.toMatchObject({
				code: 'bad_request',
			});
			// No other field passes the input.
			await expect(
				k.runner.invoke(
					'homeassistant.switch',
					{ id: fan.id, operation: 'turn_on', brightness: 255 },
					admin,
				),
			).resolves.toBeTruthy();
			await k.worker.drain();
			expect(k.http.posted.every((p) => !('brightness' in (p.json as object)))).toBe(true);
			expect(await jobs()).toHaveLength(1);
		});

		it('is not offered for a light', () => {
			expect(operationsOf('light.kitchen')).not.toContain('set_percentage');
			expect(operationsOf('fan.a')).toEqual(['turn_on', 'turn_off', 'set_percentage']);
		});
	});

	it('marks the token refused on 401 and tells the person who switched', async () => {
		k.http.servePost(`${BASE}/api/services/light/turn_on`, new ExternalHttpError('http_401'));
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect(await connection()).toMatchObject({ status: 'token_refused' });
		expect(failures).toEqual([
			{ memberId: admin.memberId, name: 'homeassistant.switch.failed', payload: { id: light.id } },
		]);
		expect(k.http.posted).toHaveLength(1);
	});

	it('gives up at once when the entity or the service is gone', async () => {
		k.http.servePost(`${BASE}/api/services/light/turn_on`, new ExternalHttpError('http_400'));
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect(k.http.posted).toHaveLength(1);
		expect(failures.map((f) => f.payload)).toEqual([{ id: light.id }]);
		expect(await connection()).not.toMatchObject({ status: 'token_refused' });
		expect(events).not.toContain('homeassistant.values.changed');
	});

	it('tries once more when Home Assistant does not answer, then gives up', async () => {
		k.http.servePost(`${BASE}/api/services/light/turn_on`, new ExternalHttpError('timeout'));
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect(failures).toEqual([]);
		k.clock.advance(60_000);
		await k.worker.drain();
		expect(k.http.posted).toHaveLength(2);
		expect(failures.map((f) => f.name)).toEqual(['homeassistant.switch.failed']);
		expect(await jobs()).toEqual([{ name: 'homeassistant.switch', status: 'succeeded' }]);
	});

	it('sends nothing when the item was no longer allowed by the time it ran', async () => {
		k.http.servePost(`${BASE}/api/services/light/turn_on`, {});
		await flip(light.id, 'turn_on');
		await allow(light.id, false);
		await k.worker.drain();
		expect(k.http.posted).toEqual([]);
		expect(failures.map((f) => f.payload)).toEqual([{ id: light.id }]);
	});

	it('drops the values kept, so the next read is live', async () => {
		k.http.serve(`${BASE}/api/states/light.ceiling_lights`, {
			text: state('light.ceiling_lights', 'off'),
		});
		expect((await values()).items[0]?.value).toMatchObject({ kind: 'binary', on: false });
		k.http.serve(`${BASE}/api/states/light.ceiling_lights`, {
			text: state('light.ceiling_lights', 'on'),
		});
		// Kept for a minute: still off.
		expect((await values()).items[0]?.value).toMatchObject({ on: false });
		k.http.servePost(`${BASE}/api/services/light/turn_on`, {});
		await flip(light.id, 'turn_on');
		await k.worker.drain();
		expect((await values()).items[0]?.value).toMatchObject({ on: true });
		// While it settles, values are read again within seconds, not after a minute.
		k.http.serve(`${BASE}/api/states/light.ceiling_lights`, {
			text: state('light.ceiling_lights', 'off'),
		});
		k.clock.advance(2_000);
		expect((await values()).items[0]?.value).toMatchObject({ on: false });
	});

	it('logs only the outcome: never the token, the address or the body', async () => {
		const lines: unknown[] = [];
		const ctx = k.contextFor('homeassistant');
		const original = ctx.logger.info;
		// biome-ignore lint/suspicious/noExplicitAny: a spy over the logger's overloads.
		(ctx.logger as any).info = (...args: unknown[]) => void lines.push(args);
		try {
			k.http.servePost(`${BASE}/api/services/light/turn_on`, new ExternalHttpError('http_500'));
			await flip(light.id, 'turn_on');
			await k.worker.drain();
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restoring the spy.
			(ctx.logger as any).info = original;
		}
		expect(JSON.stringify(lines)).toContain('http_500');
		const logged = JSON.stringify(lines);
		for (const secret of [TOKEN, '192.168.1.20', 'light.ceiling_lights', 'turn_on', 'entity_id'])
			expect(logged).not.toContain(secret);
	});

	it('offers every operation of the table as input, and no other', () => {
		const all = new Set(Object.values(CONTROLS).flat());
		expect(new Set(OPERATIONS)).toEqual(all);
	});
});

describe('an app that only suggests', () => {
	const suggesting: Actor = {
		kind: 'app',
		appId: 'app_suggest',
		roleId: 'admin',
		mode: 'suggest',
	};

	it('is refused what only a person may do: no draft, no job, nothing sent', async () => {
		await connect();
		const light = await add('light.ceiling_lights');
		await allow(light.id);
		const requests = k.http.requests.length;
		const posted = k.http.posted.length;
		const drafts = () => sql<{ id: string }>`select id from core_drafts`.execute(k.ctx.db);
		const queued = () => sql<{ id: string }>`select id from queue_jobs`.execute(k.ctx.db);
		const jobsBefore = (await queued()).rows.length;

		const calls: [string, unknown][] = [
			['homeassistant.switch', { id: light.id, operation: 'turn_on' }],
			['homeassistant.setItemControl', { id: light.id, control: false, confirm: true }],
			['homeassistant.setMySharing', { level: 'home', onDisplays: false }],
			['homeassistant.testNotify', { memberId: alex.memberId }],
		];
		for (const [id, input] of calls)
			await expect(k.runner.invoke(id, input, suggesting), id).rejects.toMatchObject({
				code: 'conflict',
			});

		expect((await drafts()).rows).toEqual([]);
		expect((await queued()).rows).toHaveLength(jobsBefore);
		expect(k.http.requests).toHaveLength(requests);
		expect(k.http.posted).toHaveLength(posted);
	});
});
