import type { Actor } from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
afterEach(() => k.close());

async function addDevice(id: string, kind: 'kiosk' | 'family' = 'kiosk') {
	await k.ctx.db
		.withTables<CoreTables>()
		.insertInto('core_devices')
		.values({
			id,
			name: id,
			kind,
			token_hash: `hash-${id}`,
			created_by: 'test',
			created_at: 1,
			last_seen_at: 1,
			revoked_at: null,
			display_capabilities: '[]',
			display_show_names: 1,
		})
		.execute();
}

const rotation = {
	pages: ['homeassistant.values'],
	todaySeconds: 60,
	pageSeconds: 20,
	backSeconds: 90,
};

const set = (actor: Actor, deviceId: string, value: unknown) =>
	k.runner.invoke('core.setDisplayPages', { deviceId, rotation: value }, actor);
const list = (actor: Actor) => k.route('core.listDisplayPages').call({ actor });
const rotationOf = (deviceId: string) => k.themes.rotationOf(k.ctx.db, deviceId);

describe('the pages a display shows between the turns of Today', () => {
	it('shows only Today until pages are chosen, then lists them and gives them to the display', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await addDevice('dev_kitchen');
		await addDevice('dev_hall');
		expect(await list(admin)).toEqual({ displays: {} });
		expect(await rotationOf('dev_kitchen')).toBeNull();

		const result = await set(admin, 'dev_kitchen', rotation);
		expect(result).toMatchObject({ status: 'applied', output: { rotation } });
		expect(await list(admin)).toEqual({ displays: { dev_kitchen: rotation } });
		expect(await rotationOf('dev_kitchen')).toEqual(rotation);
		// Another display is untouched.
		expect(await rotationOf('dev_hall')).toBeNull();
	});

	it('fills in the usual durations', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await addDevice('dev_kitchen');
		await set(admin, 'dev_kitchen', { pages: ['calendar.week'] });
		expect(await rotationOf('dev_kitchen')).toEqual({
			pages: ['calendar.week'],
			todaySeconds: 120,
			pageSeconds: 30,
			backSeconds: 120,
		});
	});

	it('takes the pages back with null', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await addDevice('dev_kitchen');
		await set(admin, 'dev_kitchen', rotation);
		await set(admin, 'dev_kitchen', null);
		expect(await rotationOf('dev_kitchen')).toBeNull();
		expect(await list(admin)).toEqual({ displays: {} });
	});

	it('is for admins of devices only, and never for the AI', async () => {
		k = await createTestKernel();
		const { actor: kid } = await k.member('member');
		await addDevice('dev_kitchen');
		await expect(set(kid, 'dev_kitchen', rotation)).rejects.toMatchObject({ code: 'forbidden' });
		// The list is a route: the server holds it to the same capability as the action.
		const route = k.registry.routes.find((r) => r.route.operationId === 'core.listDisplayPages');
		expect(route?.route.requires).toBe('core.devices.manage');
		expect(k.ctx.access.can(kid, 'core.devices.manage')).toBe(false);
		const ai: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
		await expect(set(ai, 'dev_kitchen', rotation)).rejects.toMatchObject({ code: 'forbidden' });
		const display: Actor = {
			kind: 'display',
			deviceId: 'dev_kitchen',
			capabilities: [],
			showNames: true,
		};
		await expect(set(display, 'dev_kitchen', rotation)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect(await rotationOf('dev_kitchen')).toBeNull();
	});

	it('refuses a device that is not a screen, or not there', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await addDevice('dev_phone', 'family');
		await expect(set(admin, 'dev_phone', rotation)).rejects.toMatchObject({ code: 'not_found' });
		await expect(set(admin, 'dev_nope', rotation)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('refuses bad ids, repeats, too many pages and durations out of range', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await addDevice('dev_kitchen');
		const bad = [
			{ ...rotation, pages: ['Not An Id'] },
			{ ...rotation, pages: ['nodot'] },
			{ ...rotation, pages: ['a.b', 'a.b'] },
			{ ...rotation, pages: Array.from({ length: 9 }, (_, i) => `ext.page${i}`) },
			{ ...rotation, todaySeconds: 29 },
			{ ...rotation, todaySeconds: 3601 },
			{ ...rotation, pageSeconds: 9 },
			{ ...rotation, pageSeconds: 601 },
			{ ...rotation, backSeconds: 29 },
			{ ...rotation, backSeconds: 3601 },
		];
		for (const value of bad)
			await expect(set(admin, 'dev_kitchen', value)).rejects.toMatchObject({
				code: 'bad_request',
			});
		expect(await rotationOf('dev_kitchen')).toBeNull();
		// The edges are allowed.
		await set(admin, 'dev_kitchen', {
			pages: Array.from({ length: 8 }, (_, i) => `ext.page${i}`),
			todaySeconds: 30,
			pageSeconds: 600,
			backSeconds: 3600,
		});
		expect((await rotationOf('dev_kitchen'))?.pages).toHaveLength(8);
	});

	it('drops the pages of a display that was removed', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await addDevice('dev_kitchen');
		await addDevice('dev_hall');
		await set(admin, 'dev_kitchen', rotation);
		await set(admin, 'dev_hall', rotation);

		await k.ctx.db
			.withTables<CoreTables>()
			.updateTable('core_devices')
			.set({ revoked_at: 5 })
			.where('id', '=', 'dev_kitchen')
			.execute();
		expect(await rotationOf('dev_kitchen')).toBeNull();
		expect(await list(admin)).toEqual({ displays: { dev_hall: rotation } });
		// A revoked display cannot be given pages again.
		await expect(set(admin, 'dev_kitchen', rotation)).rejects.toMatchObject({
			code: 'not_found',
		});
	});

	it('ignores a stored entry that is no longer valid', async () => {
		k = await createTestKernel();
		await addDevice('dev_kitchen');
		await k.ctx.db
			.withTables<CoreTables>()
			.insertInto('core_settings')
			.values({
				key: 'displays.pages',
				value: JSON.stringify({ displays: { dev_kitchen: { pages: 'oops' } } }),
				updated_at: 1,
			})
			.execute();
		expect(await rotationOf('dev_kitchen')).toBeNull();
	});
});
