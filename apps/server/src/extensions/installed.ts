import {
	type ExtensionPackage,
	type ExtensionPackagesPort,
	type ExtensionProblem,
	type ExtensionState,
	emptyExtensionState,
	type RefusedExtension,
	readExtensionState,
	type StagedPackage,
	writeExtensionState,
} from '@famos/core';
import { schemaState } from '@famos/db';
import { type DbExecutor, type ExtensionDefinition, FamosError, tablePrefixOf } from '@famos/sdk';
import { downloadPackage, fetchIndex, type OfficialIndex } from '../packages/official.ts';
import { compareVersions, type ExtensionStore } from '../packages/store.ts';
import { type Available, type LoadReport, summary } from './load.ts';
import { chooseInstalled, migrationProblem } from './state.ts';
import type { WebPackage } from './web.ts';

/** What the server runs at this start, and what it could not. */
export interface InstalledExtensions {
	extensions: ExtensionDefinition[];
	web: WebPackage[];
	/** Installed extensions left out, and why. */
	refused: RefusedExtension[];
	/** The ids the kernel may still leave out (the ones not always installed). */
	refusable: string[];
	/** The ids chosen to run (including any refused). */
	installed: string[];
	/** The packages that can be installed. */
	packages: ExtensionPackagesPort;
	/**
	 * The stored copy chosen for each installed extension that runs from the store (id to
	 * digest): what the store keeps when it removes old copies.
	 */
	storedInUse: Map<string, string>;
	report: LoadReport;
}

/**
 * Picks and loads the installed extensions. It reads the database before the kernel exists
 * (the installed set decides what the kernel is built from). An always installed extension that
 * cannot load stops the server; any other is left out and said why, so one broken package never
 * keeps a family from the rest.
 */
export async function loadInstalled(
	db: DbExecutor,
	available: Available,
	options: {
		store?: ExtensionStore;
		/** Where more packages can be found, when someone asks; none without a store. */
		official?: OfficialIndex;
	} = {},
): Promise<InstalledExtensions> {
	const scopes = await schemaState(db);
	// Core's table holds the state; before core's first migration there is none.
	const state = scopes.core ? await readExtensionState(db) : null;
	const installed = chooseInstalled({
		state,
		scopes,
		available: available.extensions,
		defaults: available.list.default,
		fromSource: available.from === 'source',
	});
	const byId = new Map(available.extensions.map((ext) => [ext.id, ext]));
	const unreadable = new Map(available.unreadable.map((u) => [u.id, u] as const));
	const extensions: ExtensionDefinition[] = [];
	const web: WebPackage[] = [];
	const refused: RefusedExtension[] = [];
	for (const id of installed) {
		const ext = byId.get(id);
		if (!ext) {
			refused.push({
				id,
				version: null,
				reason: unreadable.get(id)?.reason ?? 'This server has no package of it',
				code: unreadable.get(id)?.code ?? 'no_package',
			});
			continue;
		}
		const failed = state?.failed.find((f) => f.id === id && f.version === ext.version);
		if (failed && !ext.always) {
			refused.push({
				id,
				version: ext.version,
				reason: failed.reason,
				code: failed.code ?? 'start_failed',
				...(failed.params && { params: failed.params }),
			});
			continue;
		}
		let definition: ExtensionDefinition;
		try {
			definition = await ext.load();
		} catch (error) {
			if (ext.always) throw error;
			refused.push({ id, version: ext.version, reason: messageOf(error), code: 'load_failed' });
			continue;
		}
		const problem = migrationProblem(scopes[id], definition.migrations);
		if (problem) {
			if (ext.always) throw new Error(`The extension ${id} cannot run here: ${problem.reason}`);
			refused.push({ id, version: ext.version, ...problem });
			continue;
		}
		extensions.push(definition);
		const half = ext.web();
		if (half) web.push(half);
	}
	return {
		extensions,
		web,
		refused,
		refusable: available.extensions.filter((ext) => !ext.always).map((ext) => ext.id),
		installed,
		packages: packagesPort(available, options.store, options.official),
		storedInUse: new Map(
			available.extensions.flatMap((ext) =>
				ext.stored && installed.includes(ext.id) ? [[ext.id, ext.stored.digest] as const] : [],
			),
		),
		report: {
			from: available.from,
			dir: available.dir,
			loaded: summary(extensions),
			...(available.warning && { warning: available.warning }),
		},
	};
}

/**
 * The packages that can be installed: those shipped with the app (already in place, so
 * installing one needs no file step) and the store's, plus any placed since this start. Without a
 * store nothing can be installed from a file; with the official index, a package it lists can be
 * downloaded into the store's staging the way an uploaded file is.
 */
function packagesPort(
	available: Available,
	store: ExtensionStore | undefined,
	official: OfficialIndex | undefined,
): ExtensionPackagesPort {
	type Known = ExtensionPackage & { stored: boolean };
	const byId = new Map<string, Known>(
		available.extensions.map((ext) => [
			ext.id,
			{
				id: ext.id,
				version: ext.version,
				always: ext.always,
				manifest: ext.manifest,
				labels: ext.labels,
				stored: ext.stored !== undefined,
			},
		]),
	);
	const plain = ({ stored: _, ...pkg }: Known): ExtensionPackage => pkg;
	/** An older version than this server has would never run (the highest one does): refused. */
	const assertNotOlder = (staged: StagedPackage) => {
		const have = byId.get(staged.id);
		if (have && compareVersions(staged.version, have.version) < 0)
			throw new FamosError(
				'conflict',
				`This server has ${staged.id} ${have.version}; the package is the older ${staged.version}`,
				{ reason: 'older', extensionId: staged.id, version: have.version },
			);
	};
	async function stage(archive: Uint8Array) {
		if (!store) throw new FamosError('bad_request', 'This server cannot install from a file');
		const staged = await store.stage(archive);
		assertNotOlder(staged);
		return staged;
	}
	return {
		list: () => [...byId.values()].map(plain),
		async place(source) {
			if ('id' in source) {
				const found = byId.get(source.id);
				if (!found) throw new FamosError('not_found', `No extension "${source.id}" to install`);
				return plain(found);
			}
			if (!store) throw new FamosError('not_found', 'This server cannot install from a file');
			const staged = await store.staged(source.staged);
			if (staged) {
				assertNotOlder(staged);
				const have = byId.get(staged.id);
				// The same version as the shipped one: the shipped copy runs, nothing to place.
				if (have && !have.stored && compareVersions(staged.version, have.version) === 0)
					return plain(have);
			}
			const placed = await store.place(source.staged);
			const pkg: Known = {
				id: placed.id,
				version: placed.version,
				always: byId.get(placed.id)?.always ?? false,
				manifest: placed.manifest,
				labels: placed.labels,
				stored: true,
			};
			byId.set(placed.id, pkg);
			return plain(pkg);
		},
		...(store && {
			stage,
			staged: (digest: string) => store.staged(digest),
		}),
		...(store &&
			official && {
				findPackages: () => fetchIndex(official),
				download: async (entry) => stage(await downloadPackage(entry, official)),
			}),
	};
}

/**
 * Stores what this start runs, once core's tables exist: the installed set (so the rule that
 * chose it for a family without state is applied once), what each loaded extension is called in
 * the database, and that a package which loads again is no longer failed.
 */
export async function recordStart(
	db: DbExecutor,
	selection: Pick<InstalledExtensions, 'installed'>,
	running: readonly ExtensionDefinition[],
	now: number,
): Promise<void> {
	const state = (await readExtensionState(db)) ?? emptyExtensionState();
	const known = { ...state.known };
	for (const ext of running) {
		if (ext.id === 'core') continue;
		known[ext.id] = { tablePrefix: tablePrefixOf(ext.manifest), version: ext.manifest.version };
	}
	const runningVersion = new Map(running.map((ext) => [ext.id, ext.manifest.version]));
	const next: ExtensionState = {
		...state,
		// What was installed while this server started (the command line) is kept; an always
		// installed extension that is new joins.
		installed: [...new Set([...state.installed, ...selection.installed])],
		known,
		failed: state.failed.filter((f) => runningVersion.get(f.id) === undefined),
		// A start applies every waiting change: nobody's request is pending any more.
		changes: {},
		loaded: running.flatMap((ext) => (ext.id === 'core' ? [] : [ext.id])).sort(),
	};
	await writeExtensionState(db, next, now);
}

/** Notes that an extension's migrations or start failed: that version is not loaded again. */
export async function recordFailure(
	db: DbExecutor,
	failure: {
		id: string;
		version: string;
		reason: string;
		code: ExtensionProblem;
		params?: Record<string, string>;
	},
	now: number,
): Promise<void> {
	const state = (await readExtensionState(db)) ?? emptyExtensionState();
	await writeExtensionState(
		db,
		{
			...state,
			failed: [
				...state.failed.filter((f) => f.id !== failure.id),
				{ ...failure, reason: failure.reason.slice(0, 500), at: now },
			],
		},
		now,
	);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
