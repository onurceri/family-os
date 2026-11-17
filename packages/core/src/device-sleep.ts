import { type DbExecutor, defineAction, defineRoute, FamosError, idSchema } from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { deviceSleepChanged, displaySleepChanged } from './core-events.ts';
import { readJson, writeJson } from './settings-json.ts';
import type { CoreTables } from './tables.ts';

/**
 * The hours a screen or a family device goes fully dark, per device:
 * `{ devices: { <device id>: { from, until } } }` in `core_settings`. A device without an entry
 * never sleeps. The times are clock times in the family's time zone and the window may cross
 * midnight.
 */
const KEY = 'devices.sleep';

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time as HH:MM');

export const SleepWindowSchema = z
	.object({ from: TimeSchema, until: TimeSchema })
	.refine((window) => window.from !== window.until, {
		message: 'Choose two different times',
		path: ['until'],
	});
export type SleepWindow = z.infer<typeof SleepWindowSchema>;

type Stored = { devices?: Record<string, unknown> };

/** Every stored window by device id; an entry that no longer reads as a window is ignored. */
export async function sleepWindows(db: DbExecutor): Promise<Record<string, SleepWindow>> {
	const stored = await readJson<Stored>(db, KEY, {});
	const windows: Record<string, SleepWindow> = {};
	for (const [id, value] of Object.entries(stored.devices ?? {})) {
		const parsed = SleepWindowSchema.safeParse(value);
		if (parsed.success) windows[id] = parsed.data;
	}
	return windows;
}

/** The hours a device is dark, or null when it never sleeps. */
export async function sleepOf(db: DbExecutor, deviceId: string): Promise<SleepWindow | null> {
	return (await sleepWindows(db))[deviceId] ?? null;
}

export const setDeviceSleep = defineAction({
	id: 'core.setDeviceSleep',
	title: 'Set the hours a screen or a family device goes dark, or turn them off',
	input: z.object({ deviceId: idSchema('device'), sleep: SleepWindowSchema.nullable() }),
	output: z.object({ deviceId: z.string(), sleep: SleepWindowSchema.nullable() }),
	requires: CORE_CAPABILITIES.devicesManage.id,
	approval: 'never',
	async run(uow, input) {
		const table = uow.db.withTables<CoreTables>();
		const active = new Set(
			(
				await table
					.selectFrom('core_devices')
					.select('id')
					.where('kind', 'in', ['family', 'kiosk'])
					.where('revoked_at', 'is', null)
					.execute()
			).map((row) => row.id),
		);
		if (!active.has(input.deviceId)) throw new FamosError('not_found', 'No such device');
		// Devices that were removed since are dropped with this write.
		const devices: Record<string, SleepWindow> = {};
		for (const [id, window] of Object.entries(await sleepWindows(uow.db)))
			if (active.has(id)) devices[id] = window;
		if (input.sleep) devices[input.deviceId] = input.sleep;
		else delete devices[input.deviceId];
		await writeJson(uow.db, KEY, { devices }, uow.clock.now());
		// Settings reads again, a family device's signed-in person is told (no device named), and a
		// screen hears of its own change.
		uow.emit(deviceSleepChanged, {});
		uow.emit(displaySleepChanged, { deviceId: input.deviceId });
		return { deviceId: input.deviceId, sleep: input.sleep };
	},
});

export const listDeviceSleep = defineRoute({
	method: 'get',
	path: '/devices/sleep',
	operationId: 'core.listDeviceSleep',
	summary: 'The hours each screen and family device goes dark (devices without hours never do)',
	requires: CORE_CAPABILITIES.devicesManage.id,
	response: z.object({
		devices: z.array(z.object({ deviceId: z.string(), from: z.string(), until: z.string() })),
	}),
	async handle(ctx) {
		const windows = await sleepWindows(ctx.db);
		return {
			devices: Object.entries(windows)
				.map(([deviceId, window]) => ({ deviceId, ...window }))
				.sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
		};
	},
});
