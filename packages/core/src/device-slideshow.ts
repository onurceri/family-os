import { type DbExecutor, defineAction, defineRoute, FamosError, idSchema } from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { deviceSlideshowChanged } from './core-events.ts';
import { readJson, writeJson } from './settings-json.ts';
import type { CoreTables } from './tables.ts';

/**
 * Whether a family device shows the family's photos after a while without a touch. It is on for
 * every family device, so only the devices where it was turned off are kept:
 * `{ devices: { <device id>: false } }` in `core_settings`.
 */
const KEY = 'devices.slideshow';

type Stored = { devices?: Record<string, unknown> };

/** The family devices where the slideshow was turned off. */
export async function slideshowOff(db: DbExecutor): Promise<string[]> {
	const stored = await readJson<Stored>(db, KEY, {});
	return Object.entries(stored.devices ?? {})
		.filter(([, on]) => on === false)
		.map(([id]) => id)
		.sort();
}

/** Whether a family device shows the slideshow: on unless it was turned off. */
export async function slideshowOn(db: DbExecutor, deviceId: string): Promise<boolean> {
	return !(await slideshowOff(db)).includes(deviceId);
}

export const setDeviceSlideshow = defineAction({
	id: 'core.setDeviceSlideshow',
	title: 'Turn the photos a family device shows when nobody is using it on or off',
	input: z.object({ deviceId: idSchema('device'), on: z.boolean() }),
	output: z.object({ deviceId: z.string(), on: z.boolean() }),
	requires: CORE_CAPABILITIES.devicesManage.id,
	approval: 'never',
	async run(uow, input) {
		const table = uow.db.withTables<CoreTables>();
		const active = new Set(
			(
				await table
					.selectFrom('core_devices')
					.select('id')
					.where('kind', '=', 'family')
					.where('revoked_at', 'is', null)
					.execute()
			).map((row) => row.id),
		);
		if (!active.has(input.deviceId)) throw new FamosError('not_found', 'No such family device');
		// Devices that were removed since are dropped with this write.
		const devices: Record<string, false> = {};
		for (const id of await slideshowOff(uow.db)) if (active.has(id)) devices[id] = false;
		if (input.on) delete devices[input.deviceId];
		else devices[input.deviceId] = false;
		await writeJson(uow.db, KEY, { devices }, uow.clock.now());
		// The devices list in Settings reads again, and the device itself follows without a reload.
		uow.emit(deviceSlideshowChanged, {});
		return { deviceId: input.deviceId, on: input.on };
	},
});

export const listDeviceSlideshow = defineRoute({
	method: 'get',
	path: '/devices/slideshow',
	operationId: 'core.listDeviceSlideshow',
	summary: 'The family devices that show no photos when nobody is using them (on for all others)',
	requires: CORE_CAPABILITIES.devicesManage.id,
	response: z.object({ off: z.array(z.string()) }),
	async handle(ctx) {
		return { off: await slideshowOff(ctx.db) };
	},
});
