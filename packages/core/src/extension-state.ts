import { type DbExecutor, type ExtensionManifest, FamosError } from '@famos/sdk';
import { z } from 'zod';
import { readJson, writeJson } from './settings-json.ts';

/**
 * Which extensions the family installed, kept in `core_settings` under `extensions`. The server
 * reads it before it builds the kernel (it decides what to load), so it is plain JSON that needs
 * no extension's code to read:
 * - `installed`: the ids to load at the next start;
 * - `known`: every extension that ever ran here, with its table prefix and last version, so its
 *   data can still be found after it is uninstalled;
 * - `failed`: packages whose migrations or start failed; that version is not loaded again, so a
 *   broken package cannot make the server restart over and over;
 * - `restartRequestedAt`: when someone last asked the server to restart.
 */
export const ExtensionStateSchema = z.object({
	installed: z.array(z.string()),
	known: z.record(z.string(), z.object({ tablePrefix: z.string(), version: z.string() })),
	failed: z.array(
		z.object({ id: z.string(), version: z.string(), reason: z.string(), at: z.number() }),
	),
	restartRequestedAt: z.number().nullable(),
});
export type ExtensionState = z.infer<typeof ExtensionStateSchema>;

const KEY = 'extensions';

export const emptyExtensionState = (): ExtensionState => ({
	installed: [],
	known: {},
	failed: [],
	restartRequestedAt: null,
});

/** The stored state, or null when none was written yet (a new family, or one from before it). */
export async function readExtensionState(db: DbExecutor): Promise<ExtensionState | null> {
	const raw = await readJson<unknown>(db, KEY, null);
	if (raw === null) return null;
	const parsed = ExtensionStateSchema.safeParse(raw);
	if (!parsed.success)
		throw new Error(`core_settings "${KEY}" is malformed: ${parsed.error.message}`);
	return parsed.data;
}

export async function writeExtensionState(
	db: DbExecutor,
	state: ExtensionState,
	now: number,
): Promise<void> {
	await writeJson(
		db,
		KEY,
		{
			...state,
			installed: [...new Set(state.installed)].sort(),
		} satisfies ExtensionState,
		now,
	);
}

/** An extension that is installed but did not load, and why. */
export interface RefusedExtension {
	id: string;
	/** The version that was refused, when one was found. */
	version: string | null;
	reason: string;
}

/** An extension package this server can install (shipped with the app, for now). */
export interface ExtensionPackage {
	id: string;
	version: string;
	/** Always installed: it cannot be uninstalled. */
	always: boolean;
	/** What it declares it reaches (network, calls, capabilities) and what it needs. */
	manifest: ExtensionManifest;
	/** Its name and description per language code, for a package whose texts are not loaded. */
	labels: Record<string, { name: string; description: string }>;
}

/** Which package an install is of: one this server offers, by id. */
export type InstallSource = { id: string };

/**
 * The extension packages the composition root can put in place. Installing records the id in the
 * state above; the package itself loads at the next start.
 */
export interface ExtensionPackagesPort {
	/** The packages that can be installed, the always installed ones included. */
	list(): readonly ExtensionPackage[];
	/**
	 * Makes the package `source` names loadable at the next start and says which it is. A package
	 * shipped with the app is already in place. Throws `FamosError('not_found')` for an unknown one.
	 */
	place(source: InstallSource): Promise<ExtensionPackage>;
}

/** Without packages (tests): nothing beyond what the kernel was given can be installed. */
export const noExtensionPackages: ExtensionPackagesPort = {
	list: () => [],
	place: (source) =>
		Promise.reject(new FamosError('not_found', `No package "${source.id}" to install`)),
};
