import {
	type ExtensionPackage,
	type ExtensionPackagesPort,
	type ExtensionState,
	emptyExtensionState,
	type RefusedExtension,
	readExtensionState,
	writeExtensionState,
} from '@famos/core';
import { schemaState } from '@famos/db';
import { type DbExecutor, type ExtensionDefinition, FamosError, tablePrefixOf } from '@famos/sdk';
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
	const unreadable = new Map(available.unreadable.map((u) => [u.id, u.reason]));
	const extensions: ExtensionDefinition[] = [];
	const web: WebPackage[] = [];
	const refused: RefusedExtension[] = [];
	for (const id of installed) {
		const ext = byId.get(id);
		if (!ext) {
			refused.push({
				id,
				version: null,
				reason: unreadable.get(id) ?? 'This server has no package of it',
			});
			continue;
		}
		const failed = state?.failed.find((f) => f.id === id && f.version === ext.version);
		if (failed && !ext.always) {
			refused.push({ id, version: ext.version, reason: failed.reason });
			continue;
		}
		let definition: ExtensionDefinition;
		try {
			definition = await ext.load();
		} catch (error) {
			if (ext.always) throw error;
			refused.push({ id, version: ext.version, reason: messageOf(error) });
			continue;
		}
		const problem = migrationProblem(scopes[id], definition.migrations);
		if (problem) {
			if (ext.always) throw new Error(`The extension ${id} cannot run here: ${problem}`);
			refused.push({ id, version: ext.version, reason: problem });
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
		packages: shippedPackages(available),
		report: {
			from: available.from,
			dir: available.dir,
			loaded: summary(extensions),
			...(available.warning && { warning: available.warning }),
		},
	};
}

/** The packages shipped with the app: already in place, so installing one needs no file step. */
function shippedPackages(available: Available): ExtensionPackagesPort {
	const list: ExtensionPackage[] = available.extensions.map((ext) => ({
		id: ext.id,
		version: ext.version,
		always: ext.always,
		manifest: ext.manifest,
		labels: ext.labels,
	}));
	return {
		list: () => list,
		async place(source) {
			const found = list.find((p) => p.id === source.id);
			if (!found) throw new FamosError('not_found', `No extension "${source.id}" to install`);
			return found;
		},
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
	};
	await writeExtensionState(db, next, now);
}

/** Notes that an extension's migrations or start failed: that version is not loaded again. */
export async function recordFailure(
	db: DbExecutor,
	failure: { id: string; version: string; reason: string },
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
