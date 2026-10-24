import { type Actor, ExternalHttpError } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entities, Values } from '../src/contract/index.ts';
import homeassistant from '../src/server/index.ts';
import { connectHomeAssistant } from './connect.ts';

const BASE = 'http://192.168.1.20:8123';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sentinel-payload.sentinel-signature';

let k: TestKernel;
let admin: Actor;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [homeassistant] });
	admin = (await k.member('admin')).actor;
});
afterEach(() => k.close());

const entity = (entityId: string, state: string, attributes: Record<string, unknown> = {}) => ({
	entity_id: entityId,
	state,
	attributes,
	last_changed: '2026-10-17T08:30:00+00:00',
	last_reported: '2026-10-17T08:30:00+00:00',
	last_updated: '2026-10-17T08:30:00+00:00',
	context: { id: 'c', parent_id: null, user_id: null },
});

const TEMPERATURE = entity('sensor.outside_temperature', '15.6', {
	unit_of_measurement: '°C',
	device_class: 'temperature',
	friendly_name: 'Outside Temperature',
	latitude: 52.3601,
	longitude: 4.8866,
});
const DOOR = entity('binary_sensor.front_door', 'on', {
	device_class: 'door',
	friendly_name: 'Front door',
});

function serveEntity(body: ReturnType<typeof entity>) {
	k.http.serve(`${BASE}/api/states/${body.entity_id}`, { text: JSON.stringify(body) });
}

const stateRequests = () => k.http.requests.filter((r) => r.url.startsWith(`${BASE}/api/states`));

async function connect() {
	await connectHomeAssistant(k, admin, BASE, TOKEN);
}
async function add(entityId: string, label: string) {
	await k.runner.invoke('homeassistant.addItem', { entityId, label }, admin);
}
const values = async (actor: Actor = admin): Promise<Values> =>
	k.route('homeassistant.getValues').call({ actor });
const entities = async (q?: string): Promise<Entities> =>
	k.route('homeassistant.findEntities').call({ actor: admin, query: q ? { q } : {} });

describe('values', () => {
	it('reads each picked sensor and shows only the picked fields', async () => {
		serveEntity(TEMPERATURE);
		serveEntity(DOOR);
		await connect();
		await add('sensor.outside_temperature', 'Outside');
		await add('binary_sensor.front_door', 'Door');
		const result = await values();
		expect(result.status).toBe('ok');
		expect(result.items).toEqual([
			{
				id: expect.stringMatching(/^ha_item_/),
				entityId: 'sensor.outside_temperature',
				label: 'Outside',
				name: 'Outside Temperature',
				value: { kind: 'number', value: 15.6, unit: '°C' },
				changedAt: Date.parse('2026-10-17T08:30:00+00:00'),
				control: false,
				confirm: false,
			},
			{
				id: expect.stringMatching(/^ha_item_/),
				entityId: 'binary_sensor.front_door',
				label: 'Door',
				name: 'Front door',
				value: { kind: 'binary', on: true, deviceClass: 'door' },
				changedAt: Date.parse('2026-10-17T08:30:00+00:00'),
				control: false,
				confirm: false,
			},
		]);
		const shown = JSON.stringify(result);
		for (const hidden of ['latitude', '52.36', 'context', 'state_class', TOKEN])
			expect(shown).not.toContain(hidden);
	});

	it('asks with the token, read-only, and only for the picked entities', async () => {
		serveEntity(TEMPERATURE);
		await connect();
		await add('sensor.outside_temperature', 'Outside');
		await values();
		expect(stateRequests()).toHaveLength(1);
		expect(stateRequests()[0]).toMatchObject({
			url: `${BASE}/api/states/sensor.outside_temperature`,
			allowLocal: true,
			headers: { authorization: `Bearer ${TOKEN}` },
			timeoutMs: 5000,
			maxBytes: 64 * 1024,
		});
	});

	it('is for people who may see it, and displays that were granted it', async () => {
		const route = k.registry.routes.find((r) => r.route.operationId === 'homeassistant.getValues');
		expect(route?.route.requires).toBe('homeassistant.view');
		const member = (await k.member('member')).actor;
		const display = (view: boolean): Actor => ({
			kind: 'display',
			deviceId: 'dev',
			capabilities: view ? ['homeassistant.view'] : [],
			showNames: false,
		});
		expect(k.access.can(member, 'homeassistant.view')).toBe(true);
		expect(k.access.can(display(true), 'homeassistant.view')).toBe(true);
		expect(k.access.can(display(false), 'homeassistant.view')).toBe(false);
		expect(k.access.can(display(true), 'homeassistant.manage')).toBe(false);
		serveEntity(DOOR);
		await connect();
		await add('binary_sensor.front_door', 'Door');
		expect((await values(display(true))).items).toHaveLength(1);
	});

	it('asks once a minute, however many ask', async () => {
		serveEntity(DOOR);
		await connect();
		await add('binary_sensor.front_door', 'Door');
		await Promise.all([values(), values(), values()]);
		await values();
		expect(stateRequests()).toHaveLength(1);
		k.clock.advance(59_000);
		await values();
		expect(stateRequests()).toHaveLength(1);
		k.clock.advance(2_000);
		await values();
		expect(stateRequests()).toHaveLength(2);
	});

	it('asks again after the list or the connection changed', async () => {
		serveEntity(DOOR);
		serveEntity(TEMPERATURE);
		await connect();
		await add('binary_sensor.front_door', 'Door');
		await values();
		await add('sensor.outside_temperature', 'Outside');
		expect((await values()).items).toHaveLength(2);
		const before = stateRequests().length;
		await connect();
		await values();
		expect(stateRequests().length).toBeGreaterThan(before);
	});

	it('shows an entity Home Assistant does not have as not available, the others as they are', async () => {
		serveEntity(DOOR);
		k.http.serve(`${BASE}/api/states/sensor.gone`, new ExternalHttpError('http_404'));
		await connect();
		await add('sensor.gone', 'Gone');
		await add('binary_sensor.front_door', 'Door');
		const result = await values();
		expect(result.status).toBe('ok');
		expect(result.items.map((i) => i.value.kind)).toEqual(['unavailable', 'binary']);
	});

	it('shows an unknown and a malformed answer as not available', async () => {
		serveEntity(entity('sensor.a', 'unknown'));
		k.http.serve(`${BASE}/api/states/sensor.b`, { text: 'not json' });
		k.http.serve(`${BASE}/api/states/sensor.c`, {
			text: JSON.stringify(entity('sensor.other', '5')),
		});
		await connect();
		for (const id of ['a', 'b', 'c']) await add(`sensor.${id}`, id);
		const result = await values();
		expect(result.status).toBe('ok');
		expect(result.items.map((i) => i.value.kind)).toEqual([
			'unavailable',
			'unavailable',
			'unavailable',
		]);
	});

	it.each(['http_401', 'http_403', 'unreachable', 'timeout', 'http_500'] as const)(
		'shows nothing as current when Home Assistant answers %s',
		async (code) => {
			serveEntity(DOOR);
			await connect();
			await add('binary_sensor.front_door', 'Door');
			expect((await values()).items).toHaveLength(1);
			k.http.serve(`${BASE}/api/states/binary_sensor.front_door`, new ExternalHttpError(code));
			k.clock.advance(61_000);
			expect(await values()).toEqual({ items: [], status: 'unavailable' });
		},
	);

	it('makes no request when not connected', async () => {
		expect(await values()).toEqual({ items: [], status: 'not_connected' });
		await add('sensor.a', 'A');
		expect(await values()).toEqual({ items: [], status: 'not_connected' });
		expect(k.http.requests).toHaveLength(0);
	});

	it('makes no request when nothing is picked', async () => {
		await connect();
		expect(await values()).toEqual({ items: [], status: 'ok' });
		expect(stateRequests()).toHaveLength(0);
	});

	it('reads at most four at a time', async () => {
		let running = 0;
		let most = 0;
		const original = k.http.get.bind(k.http);
		k.http.get = async (request) => {
			running++;
			most = Math.max(most, running);
			await new Promise((resolve) => setTimeout(resolve, 5));
			running--;
			return original(request);
		};
		await connect();
		for (let i = 0; i < 10; i++) {
			serveEntity(entity(`sensor.s${i}`, String(i)));
			await add(`sensor.s${i}`, `S${i}`);
		}
		const result = await values();
		expect(result.items).toHaveLength(10);
		expect(most).toBe(4);
	});
});

const LIST = [
	entity('sensor.outside_temperature', '15.6', {
		unit_of_measurement: '°C',
		friendly_name: 'Outside Temperature',
	}),
	entity('sensor.living_room_humidity', '45', {
		unit_of_measurement: '%',
		friendly_name: 'Living room humidity',
	}),
	entity('binary_sensor.movement_backyard', 'off', {
		device_class: 'motion',
		friendly_name: 'Movement backyard',
	}),
	entity('person.alex', 'home', { latitude: 52.3601, longitude: 4.8866, friendly_name: 'Alex' }),
	entity('lock.front_door', 'locked', { friendly_name: 'Front door lock' }),
	entity('light.kitchen', 'on', { friendly_name: 'Kitchen' }),
	entity('device_tracker.alex_phone', 'home', { latitude: 52.3601, friendly_name: 'Alex phone' }),
	entity('zone.home', 'zoning', { latitude: 52.3601, friendly_name: 'Home' }),
];

describe('entities', () => {
	it('is for people who manage the connection', () => {
		const route = k.registry.routes.find(
			(r) => r.route.operationId === 'homeassistant.findEntities',
		);
		expect(route?.route.requires).toBe('homeassistant.manage');
	});

	it('lists every entity but people and places by name, with their value, and nothing else', async () => {
		k.http.serve(`${BASE}/api/states`, { text: JSON.stringify(LIST) });
		await connect();
		const result = await entities();
		expect(result.status).toBe('ok');
		expect(result.entities.map((e) => e.entityId)).toEqual([
			'lock.front_door',
			'light.kitchen',
			'sensor.living_room_humidity',
			'binary_sensor.movement_backyard',
			'sensor.outside_temperature',
		]);
		expect(result.entities[2]).toEqual({
			entityId: 'sensor.living_room_humidity',
			name: 'Living room humidity',
			value: { kind: 'number', value: 45, unit: '%' },
		});
		const shown = JSON.stringify(result);
		for (const hidden of ['person', 'tracker', 'zone', 'latitude', '52.36', 'Alex'])
			expect(shown).not.toContain(hidden);
		expect(k.http.requests.at(-1)).toMatchObject({
			url: `${BASE}/api/states`,
			timeoutMs: 10_000,
			maxBytes: 4 * 1024 * 1024,
		});
	});

	it('filters by a word of the name or of the id', async () => {
		k.http.serve(`${BASE}/api/states`, { text: JSON.stringify(LIST) });
		await connect();
		expect((await entities('HUMID')).entities.map((e) => e.entityId)).toEqual([
			'sensor.living_room_humidity',
		]);
		expect((await entities('backyard')).entities).toHaveLength(1);
		expect((await entities('nothing like it')).entities).toEqual([]);
	});

	it('returns at most 50', async () => {
		const many = Array.from({ length: 120 }, (_, i) =>
			entity(`sensor.s${String(i).padStart(3, '0')}`, String(i), { friendly_name: `Sensor ${i}` }),
		);
		k.http.serve(`${BASE}/api/states`, { text: JSON.stringify(many) });
		await connect();
		const all = await entities();
		expect(all.entities).toHaveLength(50);
		expect(all.more).toBe(true);
		// "Sensor 1" matches 1, 10-19 and 100-119: 31 in all, so nothing is cut.
		const narrowed = await entities('sensor 1');
		expect(narrowed.entities).toHaveLength(31);
		expect(narrowed.more).toBe(false);
		expect((await entities('sensor')).more).toBe(true);
	});

	it('is cached for a minute', async () => {
		k.http.serve(`${BASE}/api/states`, { text: JSON.stringify(LIST) });
		await connect();
		await entities();
		await entities('temp');
		expect(stateRequests()).toHaveLength(1);
		k.clock.advance(61_000);
		await entities();
		expect(stateRequests()).toHaveLength(2);
	});

	it('says too_many when the list is bigger than FamilyOS reads', async () => {
		k.http.serve(`${BASE}/api/states`, new ExternalHttpError('too_large'));
		await connect();
		expect(await entities()).toEqual({ entities: [], status: 'too_many', more: false });
	});

	it('says unavailable when Home Assistant cannot be asked', async () => {
		k.http.serve(`${BASE}/api/states`, new ExternalHttpError('http_401'));
		await connect();
		expect(await entities()).toEqual({ entities: [], status: 'unavailable', more: false });
	});

	it('makes no request when not connected', async () => {
		expect(await entities()).toEqual({ entities: [], status: 'not_connected', more: false });
		expect(k.http.requests).toHaveLength(0);
	});
});
