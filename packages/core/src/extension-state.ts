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
 * - `restartRequestedAt`: when someone last asked the server to restart;
 * - `changes`: who asked for each install or uninstall still waiting for a restart, and when
 *   (cleared at every start, when nothing waits any more);
 * - `loaded`: what the last start ran, which is still running until the next start (absent in
 *   state written before it was recorded).
 */
/**
 * Why an installed extension does not run, as a stable code a page translates (the `reason`
 * text beside it is for the log and the command line):
 * - `no_package`: this server has no package of it;
 * - `package_refused`: its stored package failed its check at start (changed, or not signed by
 *   a trusted key);
 * - `unreadable`: its package cannot be read;
 * - `load_failed`: its code could not be loaded;
 * - `newer_data`: the database holds migrations of a newer version;
 * - `migration_order`: a migration it brings sorts before one already applied;
 * - `migration_failed`, `start_failed`: its migrations or its start failed (`failed`);
 * - `sdk` (`needs`, `has`): it needs another version of FamilyOS;
 * - `missing_dependency`, `dependency_refused` (`extensionId`): what it needs is missing or was
 *   left out itself;
 * - `name_clash`: its name or tables clash with the host's or another extension's;
 * - `invalid`: its manifest and its code disagree (a fault of the package).
 */
export const EXTENSION_PROBLEMS = [
	'no_package',
	'package_refused',
	'unreadable',
	'load_failed',
	'newer_data',
	'migration_order',
	'migration_failed',
	'start_failed',
	'sdk',
	'missing_dependency',
	'dependency_refused',
	'name_clash',
	'invalid',
] as const;
export type ExtensionProblem = (typeof EXTENSION_PROBLEMS)[number];
export const ExtensionProblemSchema = z.enum(EXTENSION_PROBLEMS);
/** Values a problem's sentence names (an extension id, a version). */
export const ProblemParamsSchema = z.record(z.string(), z.string());

export const ExtensionStateSchema = z.object({
	installed: z.array(z.string()),
	known: z.record(z.string(), z.object({ tablePrefix: z.string(), version: z.string() })),
	failed: z.array(
		z.object({
			id: z.string(),
			version: z.string(),
			reason: z.string(),
			/** Absent in records written before codes existed. */
			code: ExtensionProblemSchema.optional(),
			params: ProblemParamsSchema.optional(),
			at: z.number(),
		}),
	),
	restartRequestedAt: z.number().nullable(),
	changes: z.record(z.string(), z.object({ by: z.string().nullable(), at: z.number() })).optional(),
	loaded: z.array(z.string()).optional(),
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
	/** In words, for the log and the command line. */
	reason: string;
	/** For a page to say it in the family's language. */
	code: ExtensionProblem;
	params?: Record<string, string>;
}

/** An extension package this server can install: shipped with the app, or placed in its store. */
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

/** A signed package that was uploaded and checked, waiting to be installed. */
export interface StagedPackage extends Omit<ExtensionPackage, 'always'> {
	/** Names the package exactly (a hash of its description): what an install refers to. */
	digest: string;
	/** The key that signed it, and what kind of key that is. */
	signer: { keyId: string; kind: string };
}

/**
 * A package the official index lists, as the server read it from the signed index: what it is,
 * where it is (an absolute https address on the index's own host) and the size and SHA-256 its
 * file must have.
 */
export const IndexedPackageSchema = z.object({
	id: z.string(),
	version: z.string(),
	/** The SDK range its manifest asks for. */
	sdk: z.string(),
	url: z.string(),
	sha256: z.string(),
	size: z.number(),
	labels: z.record(z.string(), z.object({ name: z.string(), description: z.string() })),
});
export type IndexedPackage = z.infer<typeof IndexedPackageSchema>;

/**
 * Which package an install is of: one this server offers, by id, or a staged one by its digest.
 */
export type InstallSource = { id: string } | { staged: string };

/**
 * The extension packages the composition root can put in place. Installing records the id in the
 * state above; the package itself loads at the next start.
 */
export interface ExtensionPackagesPort {
	/** The packages that can be installed, the always installed ones included. */
	list(): readonly ExtensionPackage[];
	/**
	 * Makes the package `source` names loadable at the next start and says which it is. A package
	 * shipped with the app is already in place; a staged one is moved into the store. Throws
	 * `FamosError('not_found')` for an unknown one. Idempotent.
	 */
	place(source: InstallSource): Promise<ExtensionPackage>;
	/**
	 * Checks an uploaded `.famext` (limits, signature, every file, the manifest) and keeps it
	 * aside until it is installed. Absent where packages cannot come from a file.
	 */
	stage?(archive: Uint8Array): Promise<StagedPackage>;
	/** A staged package by its digest, checked again; undefined when there is none. */
	staged?(digest: string): Promise<StagedPackage | undefined>;
	/**
	 * Fetches the official index and checks its signature. Throws a `FamosError` whose
	 * `details.reason` says why it failed (`unreachable`, `unsigned`, `invalid`). Absent where
	 * the server cannot look online. Network I/O: called from a job only, when a person asked.
	 */
	findPackages?(): Promise<IndexedPackage[]>;
	/**
	 * Downloads a package the index lists, checks its size and SHA-256 against the index
	 * (`details.reason` `mismatch`), then stages it like an uploaded file. Network I/O: called
	 * from a job only, when a person asked.
	 */
	download?(entry: IndexedPackage): Promise<StagedPackage>;
}

/** Without packages (tests): nothing beyond what the kernel was given can be installed. */
export const noExtensionPackages: ExtensionPackagesPort = {
	list: () => [],
	place: (source) =>
		Promise.reject(
			new FamosError(
				'not_found',
				'id' in source ? `No package "${source.id}" to install` : 'No staged package to install',
			),
		),
};
