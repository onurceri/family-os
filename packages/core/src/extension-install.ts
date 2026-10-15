import {
	type Actor,
	type DbExecutor,
	defineAction,
	defineEvent,
	defineRoute,
	type ExtensionManifest,
	FamosError,
} from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import {
	type ExtensionPackage,
	type ExtensionPackagesPort,
	type ExtensionState,
	emptyExtensionState,
	type RefusedExtension,
	readExtensionState,
	writeExtensionState,
} from './extension-state.ts';
import type { Features } from './features.ts';
import type { Registry } from './registry.ts';

/** The installed set changed (ids only): open settings pages refresh. */
export const extensionsChanged = defineEvent(
	'core.extensions.changed',
	z.object({ extensionId: z.string() }),
);
/** Someone asked the server to restart: it finishes what it does and starts again. */
export const restartRequested = defineEvent('core.restart.requested', z.object({ at: z.number() }));

const EXTENSION_STATUS = [
	/** Installed and running. */
	'loaded',
	/** Installed; it loads at the next start. */
	'pending_install',
	/** Uninstalled; it stops at the next start (its data is kept). */
	'pending_uninstall',
	/** Installed, but the server would not load it (see `reason`). */
	'refused',
	/** Installed, but its migrations or its start failed (see `reason`). */
	'failed',
	/** Not installed; it can be. */
	'available',
] as const;

const ReachesSchema = z.object({
	/** Hosts it calls itself. */
	hosts: z.array(z.string()),
	/** Whether it fetches addresses a person types. */
	userUrls: z.boolean(),
	/** Whether a person may let it reach the home network. */
	local: z.boolean(),
	/** Other extensions' (and core's) actions it runs. */
	calls: z.array(z.string()),
});

export const ExtensionEntrySchema = z.object({
	id: z.string(),
	/** The running version, else the one that would be installed. */
	version: z.string(),
	status: z.enum(EXTENSION_STATUS),
	/** Why it was refused or failed; null otherwise. */
	reason: z.string().nullable(),
	/** Always installed: it cannot be uninstalled (it can be turned off). */
	always: z.boolean(),
	/** Turned on (Features); only meaningful while it is loaded. */
	enabled: z.boolean(),
	dependsOn: z.array(z.string()),
	optional: z.array(z.string()),
	/** What it reaches outside its own data, as its manifest declares. */
	reaches: ReachesSchema,
	/** Its name and description by language code, for one whose texts are not loaded. */
	labels: z.record(z.string(), z.object({ name: z.string(), description: z.string() })),
});
export type ExtensionEntry = z.infer<typeof ExtensionEntrySchema>;

export interface ExtensionList {
	extensions: ExtensionEntry[];
	/** Something was installed or uninstalled since the server started. */
	restartNeeded: boolean;
	restartRequestedAt: number | null;
}

export interface ExtensionInstallDeps {
	packages: () => ExtensionPackagesPort;
	registry: () => Registry;
	/** Installed extensions that did not load at this start. */
	refused: () => readonly RefusedExtension[];
	features: () => Features;
}

/**
 * Installing changes what the server runs and what reaches the family's data, so only a person
 * signed in to the app (or the server's own command line) may do it: never a display, an API
 * token's agent or another AI.
 */
function assertPerson(actor: Actor, what: string) {
	if (actor.kind !== 'member' && actor.kind !== 'system')
		throw new FamosError('forbidden', `Only a signed-in member can ${what}`);
}

/**
 * Installing, uninstalling and restarting. The installed set is what the server loads when it
 * starts: changing it takes effect after a restart, and the data of an uninstalled extension is
 * kept (installing it again brings it back).
 */
export function createExtensionInstall(deps: ExtensionInstallDeps) {
	const loadedManifests = () =>
		new Map(
			deps
				.registry()
				.extensions.filter((e) => e.id !== 'core')
				.map((e) => [e.id, e.manifest] as const),
		);
	const packagesById = () =>
		new Map(
			deps
				.packages()
				.list()
				.map((p) => [p.id, p] as const),
		);

	/** The state as stored; before the server stored one, what runs now is what is installed. */
	const currentState = async (db: DbExecutor): Promise<ExtensionState> =>
		(await readExtensionState(db)) ?? {
			...emptyExtensionState(),
			installed: [...loadedManifests().keys()],
		};

	const manifestOf = (
		id: string,
		packages: ReadonlyMap<string, ExtensionPackage>,
	): ExtensionManifest | undefined => loadedManifests().get(id) ?? packages.get(id)?.manifest;

	function entries(state: ExtensionState): ExtensionEntry[] {
		const loaded = loadedManifests();
		const packages = packagesById();
		const refused = new Map(deps.refused().map((r) => [r.id, r] as const));
		const failed = new Map(state.failed.map((f) => [f.id, f] as const));
		const installed = new Set(state.installed);
		const ids = [
			...new Set([...packages.keys(), ...loaded.keys(), ...installed, ...refused.keys()]),
		].sort();
		const features = deps.features();
		return ids.map((id): ExtensionEntry => {
			const pkg = packages.get(id);
			const manifest = loaded.get(id) ?? pkg?.manifest;
			const fail = failed.get(id);
			const refusal = refused.get(id);
			const status = loaded.has(id)
				? installed.has(id)
					? 'loaded'
					: 'pending_uninstall'
				: installed.has(id)
					? fail && (!pkg || pkg.version === fail.version)
						? 'failed'
						: refusal
							? 'refused'
							: 'pending_install'
					: 'available';
			return {
				id,
				version: manifest?.version ?? refusal?.version ?? fail?.version ?? '',
				status,
				reason:
					status === 'failed'
						? (fail?.reason ?? null)
						: status === 'refused'
							? (refusal?.reason ?? null)
							: null,
				always: pkg?.always ?? false,
				enabled: features.isOn(id),
				dependsOn: manifest?.dependsOn ?? [],
				optional: manifest?.optional ?? [],
				reaches: {
					hosts: manifest?.network?.hosts ?? [],
					userUrls: manifest?.network?.userUrls ?? false,
					local: manifest?.network?.local ?? false,
					calls: manifest?.calls ?? [],
				},
				labels: pkg?.labels ?? {},
			};
		});
	}

	const needsRestart = (list: readonly ExtensionEntry[]) =>
		list.some((e) => e.status === 'pending_install' || e.status === 'pending_uninstall');

	async function describe(db: DbExecutor): Promise<ExtensionList> {
		const state = await currentState(db);
		const extensions = entries(state);
		return {
			extensions,
			restartNeeded: needsRestart(extensions),
			restartRequestedAt: state.restartRequestedAt,
		};
	}

	const ListSchema = z.object({
		extensions: z.array(ExtensionEntrySchema),
		restartNeeded: z.boolean(),
		restartRequestedAt: z.number().nullable(),
	}) satisfies z.ZodType<ExtensionList>;

	const list = defineRoute({
		method: 'get',
		path: '/extensions',
		operationId: 'core.listExtensions',
		summary: 'The extensions installed and the ones that can be, with what each reaches',
		requires: CORE_CAPABILITIES.extensionsManage.id,
		response: ListSchema,
		handle: (ctx) => describe(ctx.db),
	});

	const ChangeOutputSchema = z.object({
		/** Every id the change added or removed: an install also adds what the extension needs. */
		changed: z.array(z.string()),
		restartNeeded: z.boolean(),
	});

	const install = defineAction({
		id: 'core.installExtension',
		title: 'Install an extension',
		input: z.object({ extensionId: z.string().max(64) }),
		output: ChangeOutputSchema,
		requires: CORE_CAPABILITIES.extensionsManage.id,
		approval: 'never',
		// Putting a package in place is the action's one effect outside the database. It is
		// idempotent (a shipped package is already there) and the installed set commits with it.
		async run(uow, input) {
			assertPerson(uow.actor, 'install extensions');
			const packages = packagesById();
			if (!packages.has(input.extensionId))
				throw new FamosError('not_found', `No extension "${input.extensionId}" to install`);
			const state = await currentState(uow.db);
			const installed = new Set(state.installed);
			// What it needs comes with it, dependencies first; all of it must be at hand.
			const adding: string[] = [];
			const visit = (id: string, path: readonly string[]) => {
				if (installed.has(id) || adding.includes(id)) return;
				if (path.includes(id)) return;
				const manifest = manifestOf(id, packages);
				if (!manifest || !packages.has(id))
					throw new FamosError(
						'conflict',
						`"${path.at(-1) ?? id}" needs "${id}", which this server does not have`,
						{ reason: 'missing_dependency', extensionId: id },
					);
				for (const dep of manifest.dependsOn) visit(dep, [...path, id]);
				adding.push(id);
			};
			visit(input.extensionId, []);
			for (const id of adding) await deps.packages().place({ id });
			const failedAgain = new Set([input.extensionId, ...adding]);
			const next: ExtensionState = {
				...state,
				installed: [...installed, ...adding],
				// Installing again is how a person asks to try a failed package once more.
				failed: state.failed.filter((f) => !failedAgain.has(f.id)),
			};
			await writeExtensionState(uow.db, next, uow.clock.now());
			uow.emit(extensionsChanged, { extensionId: input.extensionId });
			return { changed: adding, restartNeeded: needsRestart(entries(next)) };
		},
	});

	const uninstall = defineAction({
		id: 'core.uninstallExtension',
		title: 'Uninstall an extension (its data is kept)',
		input: z.object({ extensionId: z.string().max(64) }),
		output: ChangeOutputSchema,
		requires: CORE_CAPABILITIES.extensionsManage.id,
		approval: 'never',
		async run(uow, input) {
			assertPerson(uow.actor, 'uninstall extensions');
			const packages = packagesById();
			const id = input.extensionId;
			if (packages.get(id)?.always)
				throw new FamosError('conflict', `"${id}" is always installed; it can be turned off`, {
					reason: 'always',
				});
			const state = await currentState(uow.db);
			if (!state.installed.includes(id))
				throw new FamosError('not_found', `"${id}" is not installed`);
			const neededBy = state.installed.filter(
				(other) => other !== id && manifestOf(other, packages)?.dependsOn.includes(id),
			);
			if (neededBy.length > 0)
				throw new FamosError('conflict', `"${id}" is needed by ${neededBy.join(', ')}`, {
					reason: 'needed_by',
					neededBy,
				});
			const next: ExtensionState = {
				...state,
				installed: state.installed.filter((other) => other !== id),
			};
			await writeExtensionState(uow.db, next, uow.clock.now());
			uow.emit(extensionsChanged, { extensionId: id });
			return { changed: [id], restartNeeded: needsRestart(entries(next)) };
		},
	});

	const restart = defineAction({
		id: 'core.restartServer',
		title: 'Restart the server',
		input: z.object({}),
		output: z.object({ requestedAt: z.number() }),
		requires: CORE_CAPABILITIES.extensionsManage.id,
		approval: 'never',
		async run(uow) {
			assertPerson(uow.actor, 'restart the server');
			const at = uow.clock.now();
			const state = await currentState(uow.db);
			await writeExtensionState(uow.db, { ...state, restartRequestedAt: at }, at);
			// The serving process restarts on this event (after commit); others notice the time.
			uow.emit(restartRequested, { at });
			return { requestedAt: at };
		},
	});

	return {
		actions: [install, uninstall, restart],
		routes: [list],
		events: [extensionsChanged, restartRequested],
		/** What `core.listExtensions` answers. */
		describe,
	};
}
