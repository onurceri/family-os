import type { DbExecutor } from '@famos/sdk';
import { z } from 'zod';
import type { CoreTables } from './tables.ts';

/**
 * Extensions the family turned off (Settings → Family → Extensions). A turned-off extension keeps its data
 * but stops: its routes and actions answer `feature_off`, its actions leave the AI catalog, its
 * jobs pause, its capabilities are inactive and its UI disappears. Core cannot be turned off.
 * Cached in memory like custom roles; refreshed after a change commits.
 */
export interface Features {
	isOn(extensionId: string): boolean;
	/** Ids of the turned-off extensions. */
	disabled(): readonly string[];
	refresh(db: DbExecutor): Promise<void>;
}

const KEY = 'features';
const StoredSchema = z.object({ disabled: z.array(z.string()) });

/** The extension that owns a namespaced id (`calendar.createEvent` → `calendar`). */
export function ownerOf(id: string): string {
	const dot = id.indexOf('.');
	return dot === -1 ? id : id.slice(0, dot);
}

export function createFeatures(): Features {
	let off = new Set<string>();
	return {
		isOn: (extensionId) => extensionId === 'core' || !off.has(extensionId),
		disabled: () => [...off],
		async refresh(db) {
			off = new Set(await readDisabled(db));
		},
	};
}

export async function readDisabled(db: DbExecutor): Promise<string[]> {
	const row = await db
		.withTables<CoreTables>()
		.selectFrom('core_settings')
		.select('value')
		.where('key', '=', KEY)
		.executeTakeFirst();
	if (!row) return [];
	const parsed = StoredSchema.safeParse(JSON.parse(row.value));
	return parsed.success ? parsed.data.disabled : [];
}

export async function writeDisabled(db: DbExecutor, disabled: string[], now: number) {
	const value = JSON.stringify({ disabled: [...new Set(disabled)].sort() });
	await db
		.withTables<CoreTables>()
		.insertInto('core_settings')
		.values({ key: KEY, value, updated_at: now })
		.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
		.execute();
}
