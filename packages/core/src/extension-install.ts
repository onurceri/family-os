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
	createExtensionFind,
	ExtensionDownloadSchema,
	ExtensionSearchSchema,
	FoundExtensionSchema,
} from './extension-find.ts';
import {
	type ExtensionPackage,
	type ExtensionPackagesPort,
	ExtensionProblemSchema,
	type ExtensionState,
	emptyExtensionState,
	type InstallSource,
	ProblemParamsSchema,
	type RefusedExtension,
	readExtensionState,
	type StagedPackage,
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
	/** The capabilities it adds, which roles can then be given. */
	capabilities: z.array(z.string()),
});

export const ExtensionEntrySchema = z.object({
	id: z.string(),
	/** The running version, else the one that would be installed. */
	version: z.string(),
	status: z.enum(EXTENSION_STATUS),
	/** Why it was refused or failed, in words for the log and the command line; null otherwise. */
	reason: z.string().nullable(),
	/** The same as a code a page translates (null when none is known: say it generally). */
	reasonCode: ExtensionProblemSchema.nullable(),
	/** The values its sentence names (an extension id, a version). */
	reasonParams: ProblemParamsSchema,
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
	/**
	 * The version that loads at the next start when it is not the one running (a newer package
	 * was installed from a file); null otherwise.
	 */
	nextVersion: z.string().nullable(),
	/**
	 * Who asked for the change that waits for a restart, and when (the member's id; null when the
	 * server's own command line did); null while nothing waits.
	 */
	changedBy: z.object({ memberId: z.string().nullable(), at: z.number() }).nullable(),
});
export type ExtensionEntry = z.infer<typeof ExtensionEntrySchema>;

/** The most an uploaded package may weigh, with the form around it. */
export const EXTENSION_UPLOAD_MAX_BYTES = 20 * 1024 * 1024 + 64 * 1024;

/** A package uploaded and checked, which `core.installExtension` can install by its digest. */
export const StagedExtensionSchema = z.object({
	/** What `core.installExtension` takes as `staged`. */
	digest: z.string(),
	id: z.string(),
	version: z.string(),
	/** The version running now, which the package would update, or null when it does not run. */
	current: z.string().nullable(),
	labels: z.record(z.string(), z.object({ name: z.string(), description: z.string() })),
	dependsOn: z.array(z.string()),
	optional: z.array(z.string()),
	reaches: ReachesSchema,
	/** The key that signed it: `official` is the FamilyOS project's. */
	signer: z.object({ keyId: z.string(), kind: z.string() }),
});
export type StagedExtension = z.infer<typeof StagedExtensionSchema>;

const reachesOf = (manifest: ExtensionManifest | undefined) => ({
	hosts: manifest?.network?.hosts ?? [],
	userUrls: manifest?.network?.userUrls ?? false,
	local: manifest?.network?.local ?? false,
	calls: manifest?.calls ?? [],
	capabilities: manifest?.capabilities ?? [],
});

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

	/** Who asks and when, as a change waiting for a restart is remembered. */
	const askedBy = (uow: { actor: Actor; clock: { now(): number } }) => ({
		by: uow.actor.kind === 'member' ? uow.actor.memberId : null,
		at: uow.clock.now(),
	});

	/** Keeps who asked only for what still waits: keeping an extension again cancels its change. */
	function onlyWaiting(state: ExtensionState): ExtensionState['changes'] {
		const waiting = new Set(
			entries(state)
				.filter(
					(e) =>
						e.status === 'pending_install' ||
						e.status === 'pending_uninstall' ||
						e.nextVersion !== null,
				)
				.map((e) => e.id),
		);
		return Object.fromEntries(
			Object.entries(state.changes ?? {}).filter(([id]) => waiting.has(id)),
		);
	}

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
			const running = loaded.get(id);
			const manifest = running ?? pkg?.manifest;
			const fail = failed.get(id);
			const refusal = refused.get(id);
			const nextVersion =
				running && pkg && installed.has(id) && pkg.version !== running.version ? pkg.version : null;
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
				reasonCode:
					status === 'failed'
						? (fail?.code ?? null)
						: status === 'refused'
							? (refusal?.code ?? null)
							: null,
				reasonParams:
					(status === 'failed'
						? fail?.params
						: status === 'refused'
							? refusal?.params
							: undefined) ?? {},
				always: pkg?.always ?? false,
				enabled: features.isOn(id),
				dependsOn: manifest?.dependsOn ?? [],
				optional: manifest?.optional ?? [],
				reaches: reachesOf(manifest),
				labels: pkg?.labels ?? {},
				nextVersion,
				changedBy:
					(status === 'pending_install' ||
						status === 'pending_uninstall' ||
						nextVersion !== null) &&
					state.changes?.[id]
						? { memberId: state.changes[id].by, at: state.changes[id].at }
						: null,
			};
		});
	}

	const needsRestart = (list: readonly ExtensionEntry[]) =>
		list.some(
			(e) =>
				e.status === 'pending_install' ||
				e.status === 'pending_uninstall' ||
				e.nextVersion !== null,
		);

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

	/**
	 * Checks an uploaded package and keeps it aside. Nothing is installed yet: the answer says what
	 * the package is, who signed it and what it reaches, for a person to confirm with
	 * `core.installExtension` ({ staged: digest }).
	 */
	const upload = defineRoute({
		method: 'post',
		path: '/extensions/packages',
		operationId: 'core.uploadExtensionPackage',
		summary: 'Upload a signed extension package (.famext) to install',
		requires: CORE_CAPABILITIES.extensionsManage.id,
		upload: {
			maxBytes: EXTENSION_UPLOAD_MAX_BYTES,
			maxFiles: 1,
			// Browsers know no type for .famext and send it as bytes.
			accept: ['application/octet-stream', 'application/gzip', 'application/x-gzip'],
		},
		response: StagedExtensionSchema,
		async handle(_ctx, request) {
			assertPerson(request.actor, 'install extensions');
			const [file] = request.files;
			if (!file) throw new FamosError('bad_request', 'Choose a package file');
			const port = deps.packages();
			if (!port.stage)
				throw new FamosError('bad_request', 'This server cannot install from a file');
			return describeStaged(await port.stage(await file.bytes()));
		},
	});

	function describeStaged(staged: StagedPackage): StagedExtension {
		const current = loadedManifests().get(staged.id)?.version ?? null;
		return {
			digest: staged.digest,
			id: staged.id,
			version: staged.version,
			current,
			labels: staged.labels,
			dependsOn: staged.manifest.dependsOn,
			optional: staged.manifest.optional,
			reaches: reachesOf(staged.manifest),
			signer: staged.signer,
		};
	}

	const install = defineAction({
		id: 'core.installExtension',
		title: 'Install an extension',
		description:
			'Installs a package this server offers (`extensionId`), or one uploaded with core.uploadExtensionPackage (`staged`: its digest).',
		input: z.union([
			z.object({ extensionId: z.string().max(64) }),
			z.object({ staged: z.string().regex(/^[0-9a-f]{32}$/) }),
		]),
		output: ChangeOutputSchema,
		requires: CORE_CAPABILITIES.extensionsManage.id,
		approval: 'never',
		// Putting a package in place is the action's one effect outside the database. It is
		// idempotent (a shipped package is already there, a staged one is moved once) and the
		// installed set commits with it.
		async run(uow, input) {
			assertPerson(uow.actor, 'install extensions');
			const packages = packagesById();
			let staged: StagedPackage | undefined;
			if ('staged' in input) {
				staged = await deps.packages().staged?.(input.staged);
				if (!staged) throw new FamosError('not_found', 'No such uploaded package; upload it again');
			} else if (!packages.has(input.extensionId)) {
				throw new FamosError('not_found', `No extension "${input.extensionId}" to install`);
			}
			const rootId = staged?.id ?? ('extensionId' in input ? input.extensionId : '');
			const state = await currentState(uow.db);
			const installed = new Set(state.installed);
			// What it needs comes with it, dependencies first; all of it must be at hand. A staged
			// package is placed even when its extension is installed: it is a new version of it.
			const adding: string[] = [];
			const visit = (id: string, path: readonly string[]) => {
				if (adding.includes(id) || path.includes(id)) return;
				const isStaged = id === staged?.id;
				if (installed.has(id) && !isStaged) return;
				const manifest = isStaged ? staged?.manifest : manifestOf(id, packages);
				if (!manifest || (!isStaged && !packages.has(id)))
					throw new FamosError(
						'conflict',
						`"${path.at(-1) ?? id}" needs "${id}", which this server does not have`,
						{ reason: 'missing_dependency', extensionId: id },
					);
				for (const dep of manifest.dependsOn) visit(dep, [...path, id]);
				adding.push(id);
			};
			visit(rootId, []);
			const sources: InstallSource[] = adding.map((id) =>
				staged && id === staged.id ? { staged: staged.digest } : { id },
			);
			for (const source of sources) await deps.packages().place(source);
			const failedAgain = new Set([rootId, ...adding]);
			const next: ExtensionState = {
				...state,
				installed: [...installed, ...adding],
				// Installing again is how a person asks to try a failed package once more.
				failed: state.failed.filter((f) => !failedAgain.has(f.id)),
				changes: {
					...state.changes,
					...Object.fromEntries(adding.map((id) => [id, askedBy(uow)])),
				},
			};
			next.changes = onlyWaiting(next);
			await writeExtensionState(uow.db, next, uow.clock.now());
			uow.emit(extensionsChanged, { extensionId: rootId });
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
				changes: { ...state.changes, [id]: askedBy(uow) },
			};
			next.changes = onlyWaiting(next);
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

	const finder = createExtensionFind({ packages: deps.packages, assertPerson });

	const FoundSchema = z.object({
		/** The last search, or null when nobody looked yet. */
		search: ExtensionSearchSchema.nullable(),
		found: z.array(FoundExtensionSchema),
		/** The last download, with what was staged once it is ready (null when it is gone). */
		download: ExtensionDownloadSchema.extend({
			staged: StagedExtensionSchema.nullable(),
		}).nullable(),
	});

	const found = defineRoute({
		method: 'get',
		path: '/extensions/found',
		operationId: 'core.getFoundExtensions',
		summary: 'What the last look in the official index found, and the last download from it',
		requires: CORE_CAPABILITIES.extensionsManage.id,
		response: FoundSchema,
		async handle(ctx) {
			const { download, ...rest } = await finder.describe(ctx.db);
			return {
				...rest,
				download: download && {
					...download,
					staged: download.staged && describeStaged(download.staged),
				},
			};
		},
	});

	return {
		actions: [install, uninstall, restart, ...finder.actions],
		routes: [list, upload, found],
		jobs: finder.jobs,
		events: [extensionsChanged, restartRequested, ...finder.events],
		/** What `core.listExtensions` answers. */
		describe,
	};
}
