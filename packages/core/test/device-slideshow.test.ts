import type { Actor } from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
afterEach(() => k.close());

const meOn = async (actor: Actor, device: { id: string; name: string } | null) =>
	(await k.route('core.getMe').call({ actor, device })).device;

describe('photos on a family device when nobody is using it', () => {
	it('is on for every family device until an admin turns it off for one', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const kitchen = (await k.devices.trust(admin, { name: 'Kitchen tablet' })).device;
		const hall = (await k.devices.trust(admin, { name: 'Hall tablet' })).device;
		const on = { id: kitchen.id, name: kitchen.name };

		expect(await meOn(admin, on)).toEqual({ slideshow: true });
		expect(await k.route('core.listDeviceSlideshow').call({ actor: admin })).toEqual({ off: [] });

		const result = await k.runner.invoke(
			'core.setDeviceSlideshow',
			{ deviceId: kitchen.id, on: false },
			admin,
		);
		expect(result).toMatchObject({
			status: 'applied',
			output: { deviceId: kitchen.id, on: false },
		});
		expect(await meOn(admin, on)).toEqual({ slideshow: false });
		expect(await meOn(admin, { id: hall.id, name: hall.name })).toEqual({ slideshow: true });
		expect(await k.route('core.listDeviceSlideshow').call({ actor: admin })).toEqual({
			off: [kitchen.id],
		});

		await k.runner.invoke('core.setDeviceSlideshow', { deviceId: kitchen.id, on: true }, admin);
		expect(await meOn(admin, on)).toEqual({ slideshow: true });
		expect(await k.route('core.listDeviceSlideshow').call({ actor: admin })).toEqual({ off: [] });
	});

	it('says nothing about a device on a browser that is not a family device', async () => {
		k = await createTestKernel();
		const { actor: kid } = await k.member('member');
		expect(await meOn(kid, null)).toBeNull();
	});

	it('is a setting of family devices only, changed only by who manages devices', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const { actor: kid } = await k.member('member');
		const kitchen = (await k.devices.trust(admin, { name: 'Kitchen tablet' })).device;
		const screen = (await k.devices.trust(admin, { name: 'Hallway', kind: 'kiosk' })).device;

		await expect(
			k.runner.invoke('core.setDeviceSlideshow', { deviceId: kitchen.id, on: false }, kid),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke('core.setDeviceSlideshow', { deviceId: screen.id, on: false }, admin),
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			k.runner.invoke(
				'core.setDeviceSlideshow',
				{ deviceId: 'device_00000000-0000-7000-8000-000000000000', on: false },
				admin,
			),
		).rejects.toMatchObject({ code: 'not_found' });

		// A removed device is refused, and its old choice is dropped with the next change.
		await k.runner.invoke('core.setDeviceSlideshow', { deviceId: kitchen.id, on: false }, admin);
		await k.devices.revoke(admin, kitchen.id);
		await expect(
			k.runner.invoke('core.setDeviceSlideshow', { deviceId: kitchen.id, on: true }, admin),
		).rejects.toMatchObject({ code: 'not_found' });
		const tablet = (await k.devices.trust(admin, { name: 'New tablet' })).device;
		await k.runner.invoke('core.setDeviceSlideshow', { deviceId: tablet.id, on: false }, admin);
		expect(await k.route('core.listDeviceSlideshow').call({ actor: admin })).toEqual({
			off: [tablet.id],
		});
	});
});
