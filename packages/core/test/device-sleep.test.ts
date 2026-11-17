import type { Actor } from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
afterEach(() => k.close());

const sleepOnMe = async (actor: Actor, device: { id: string; name: string } | null) =>
	(await k.route('core.getMe').call({ actor, device })).device?.sleep;
const night = { from: '22:00', until: '07:00' };

describe('dark hours of a screen or a family device', () => {
	it('is off for every device until an admin sets hours, and off again with null', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const kitchen = (await k.devices.trust(admin, { name: 'Kitchen tablet' })).device;
		const on = { id: kitchen.id, name: kitchen.name };

		expect(await sleepOnMe(admin, on)).toBeNull();
		expect(await k.route('core.listDeviceSleep').call({ actor: admin })).toEqual({ devices: [] });

		const result = await k.runner.invoke(
			'core.setDeviceSleep',
			{ deviceId: kitchen.id, sleep: night },
			admin,
		);
		expect(result).toMatchObject({
			status: 'applied',
			output: { deviceId: kitchen.id, sleep: night },
		});
		expect(await sleepOnMe(admin, on)).toEqual(night);
		expect(await k.route('core.listDeviceSleep').call({ actor: admin })).toEqual({
			devices: [{ deviceId: kitchen.id, ...night }],
		});
		// A window across midnight and one inside a day are both fine.
		await k.runner.invoke(
			'core.setDeviceSleep',
			{ deviceId: kitchen.id, sleep: { from: '13:00', until: '15:30' } },
			admin,
		);
		expect(await sleepOnMe(admin, on)).toEqual({ from: '13:00', until: '15:30' });

		await k.runner.invoke('core.setDeviceSleep', { deviceId: kitchen.id, sleep: null }, admin);
		expect(await sleepOnMe(admin, on)).toBeNull();
		expect(await k.route('core.listDeviceSleep').call({ actor: admin })).toEqual({ devices: [] });
	});

	it('works for a screen too, and tells a screen only about its own change', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const screen = (await k.devices.trust(admin, { name: 'Hallway', kind: 'kiosk' })).device;
		const heard: Array<{ name: string; payload: unknown }> = [];
		k.bus.onAny((name, payload) => void heard.push({ name, payload }));

		await k.runner.invoke('core.setDeviceSleep', { deviceId: screen.id, sleep: night }, admin);
		expect(await k.route('core.listDeviceSleep').call({ actor: admin })).toEqual({
			devices: [{ deviceId: screen.id, ...night }],
		});
		// The one for people names no device; the one for the screen names its own.
		expect(heard.find((h) => h.name === 'core.device.sleep.changed')?.payload).toEqual({});
		expect(heard.find((h) => h.name === 'core.device.sleep.display')?.payload).toEqual({
			deviceId: screen.id,
		});
	});

	it('refuses the same time twice and times that are no clock time', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const kitchen = (await k.devices.trust(admin, { name: 'Kitchen tablet' })).device;
		for (const sleep of [
			{ from: '22:00', until: '22:00' },
			{ from: '24:00', until: '07:00' },
			{ from: '22:00', until: '7:00' },
			{ from: '22:60', until: '07:00' },
		])
			await expect(
				k.runner.invoke('core.setDeviceSleep', { deviceId: kitchen.id, sleep }, admin),
			).rejects.toBeTruthy();
		expect(await k.route('core.listDeviceSleep').call({ actor: admin })).toEqual({ devices: [] });
	});

	it('is changed only by who manages devices, and only for a device that exists', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const { actor: kid } = await k.member('member');
		const kitchen = (await k.devices.trust(admin, { name: 'Kitchen tablet' })).device;

		await expect(
			k.runner.invoke('core.setDeviceSleep', { deviceId: kitchen.id, sleep: night }, kid),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke(
				'core.setDeviceSleep',
				{ deviceId: 'device_00000000-0000-7000-8000-000000000000', sleep: night },
				admin,
			),
		).rejects.toMatchObject({ code: 'not_found' });

		// A removed device is refused, and its hours are dropped with the next change.
		await k.runner.invoke('core.setDeviceSleep', { deviceId: kitchen.id, sleep: night }, admin);
		await k.devices.revoke(admin, kitchen.id);
		await expect(
			k.runner.invoke('core.setDeviceSleep', { deviceId: kitchen.id, sleep: null }, admin),
		).rejects.toMatchObject({ code: 'not_found' });
		const tablet = (await k.devices.trust(admin, { name: 'New tablet' })).device;
		await k.runner.invoke('core.setDeviceSleep', { deviceId: tablet.id, sleep: night }, admin);
		expect(await k.route('core.listDeviceSleep').call({ actor: admin })).toEqual({
			devices: [{ deviceId: tablet.id, ...night }],
		});
	});

	it('is told to a family device before anyone is signed in', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const kitchen = (await k.devices.trust(admin, { name: 'Kitchen tablet' })).device;
		const device = { id: kitchen.id, name: kitchen.name };
		await k.runner.invoke('core.setDeviceSleep', { deviceId: kitchen.id, sleep: night }, admin);

		const seen = await k.route('core.getDeviceSleep').call({ actor: admin, device });
		expect(seen.sleep).toEqual(night);
		expect(typeof seen.timeZone).toBe('string');
		expect(
			(await k.route('core.getDeviceSleep').call({ actor: admin, device: null })).sleep,
		).toBeNull();
	});
});
