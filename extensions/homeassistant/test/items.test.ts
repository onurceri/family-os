import type { Actor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item } from '../src/contract/index.ts';
import homeassistant from '../src/server/index.ts';
import { connectHomeAssistant } from './connect.ts';

let k: TestKernel;
let admin: Actor;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [homeassistant] });
	admin = (await k.member('admin')).actor;
});
afterEach(() => k.close());

async function add(entityId: string, label = entityId, who: Actor = admin): Promise<Item> {
	const r = await k.runner.invoke<Item>('homeassistant.addItem', { entityId, label }, who);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output;
}

const list = async (): Promise<Item[]> =>
	(await k.route('homeassistant.listItems').call({ actor: admin })).items;
const order = async () => (await list()).map((i) => `${i.position}:${i.entityId}`);

describe('addItem', () => {
	it('adds at the end, with the label trimmed', async () => {
		const first = await add('sensor.outside_temperature', '  Outside ');
		const second = await add('binary_sensor.front_door', 'Front door');
		expect(first).toMatchObject({ label: 'Outside', position: 0 });
		expect(first.id).toMatch(/^ha_item_/);
		expect(second.position).toBe(1);
		expect(await order()).toEqual(['0:sensor.outside_temperature', '1:binary_sensor.front_door']);
	});

	it('refuses a sensor that is already shown', async () => {
		await add('sensor.a');
		await expect(
			k.runner.invoke('homeassistant.addItem', { entityId: 'sensor.a', label: 'Again' }, admin),
		).rejects.toMatchObject({ code: 'conflict' });
		expect(await list()).toHaveLength(1);
	});

	it('refuses a thirteenth', async () => {
		for (let i = 0; i < 12; i++) await add(`sensor.s${i}`);
		await expect(
			k.runner.invoke('homeassistant.addItem', { entityId: 'sensor.s12', label: 'One' }, admin),
		).rejects.toMatchObject({ code: 'limit_reached' });
		expect(await list()).toHaveLength(12);
	});

	it.each(['person.alex', 'device_tracker.alex_phone', 'zone.home', 'person.', 'Person.alex'])(
		'refuses %s: where people are is not shown',
		async (entityId) => {
			await expect(
				k.runner.invoke('homeassistant.addItem', { entityId, label: 'X' }, admin),
			).rejects.toBeDefined();
			expect(await list()).toHaveLength(0);
		},
	);

	it.each(['sensor.Upper', 'sensor.', 'sensor.a.b', 'binary_sensor', '.a', 'sensor.a b'])(
		'refuses the malformed id %s',
		async (entityId) => {
			await expect(
				k.runner.invoke('homeassistant.addItem', { entityId, label: 'X' }, admin),
			).rejects.toBeDefined();
			expect(await list()).toHaveLength(0);
		},
	);

	it.each([
		'sensor.a',
		'binary_sensor.door',
		'lock.front_door',
		'light.x',
		'switch.heater',
		'climate.hall',
		'cover.garage',
		'weather.home',
		'media_player.tv',
	])('accepts %s: it is only read', async (entityId) => {
		await add(entityId);
		expect(await list()).toHaveLength(1);
	});

	it.each(['', '   ', 'x'.repeat(41)])('refuses the label %j', async (label) => {
		await expect(
			k.runner.invoke('homeassistant.addItem', { entityId: 'sensor.a', label }, admin),
		).rejects.toBeDefined();
	});

	it('is for people who manage the connection only', async () => {
		for (const who of [(await k.member('member')).actor, (await k.member('supervised')).actor]) {
			await expect(
				k.runner.invoke('homeassistant.addItem', { entityId: 'sensor.a', label: 'A' }, who),
			).rejects.toMatchObject({ code: 'forbidden' });
		}
		const item = await add('sensor.a');
		const member = (await k.member('member')).actor;
		for (const [id, input] of [
			['homeassistant.renameItem', { id: item.id, label: 'B' }],
			['homeassistant.moveItem', { id: item.id, position: 0 }],
			['homeassistant.removeItem', { id: item.id }],
		] as const)
			await expect(k.runner.invoke(id, input, member)).rejects.toMatchObject({
				code: 'forbidden',
			});
		expect(await list()).toMatchObject([{ label: 'sensor.a' }]);
	});
});

describe('renameItem', () => {
	it('changes the label only', async () => {
		const item = await add('sensor.a', 'A');
		const r = await k.runner.invoke<Item>(
			'homeassistant.renameItem',
			{ id: item.id, label: ' Kitchen ' },
			admin,
		);
		expect(r.status === 'applied' && r.output).toMatchObject({
			entityId: 'sensor.a',
			label: 'Kitchen',
			position: 0,
		});
	});

	it('refuses an item that is not there', async () => {
		await expect(
			k.runner.invoke('homeassistant.renameItem', { id: 'ha_item_none', label: 'X' }, admin),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('moveItem', () => {
	it('moves down, up and clamps, renumbering as it goes', async () => {
		const a = await add('sensor.a');
		const b = await add('sensor.b');
		const c = await add('sensor.c');
		const move = (id: string, position: number) =>
			k.runner.invoke('homeassistant.moveItem', { id, position }, admin);
		await move(a.id, 2);
		expect(await order()).toEqual(['0:sensor.b', '1:sensor.c', '2:sensor.a']);
		await move(c.id, 0);
		expect(await order()).toEqual(['0:sensor.c', '1:sensor.b', '2:sensor.a']);
		await move(b.id, 12);
		expect(await order()).toEqual(['0:sensor.c', '1:sensor.a', '2:sensor.b']);
	});
});

describe('removeItem', () => {
	it('removes it and renumbers the rest', async () => {
		await add('sensor.a');
		const b = await add('sensor.b');
		await add('sensor.c');
		await k.runner.invoke('homeassistant.removeItem', { id: b.id }, admin);
		expect(await order()).toEqual(['0:sensor.a', '1:sensor.c']);
		const d = await add('sensor.d');
		expect(d.position).toBe(2);
	});

	it('is kept when Home Assistant is disconnected', async () => {
		await add('sensor.a');
		await connectHomeAssistant(k, admin, 'http://192.168.1.20:8123', 'tok');
		await k.runner.invoke('homeassistant.disconnect', {}, admin);
		expect(await order()).toEqual(['0:sensor.a']);
	});
});
