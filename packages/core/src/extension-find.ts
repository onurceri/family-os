import {
	type Actor,
	compareVersions,
	type DbExecutor,
	defineAction,
	defineEvent,
	defineJob,
	FamosError,
	isFamosError,
	SDK_VERSION,
	satisfiesCaret,
} from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import {
	type ExtensionPackagesPort,
	type IndexedPackage,
	IndexedPackageSchema,
	IndexReachSchema,
	ProblemParamsSchema,
	type StagedPackage,
} from './extension-state.ts';
import { readJson, writeJson } from './settings-json.ts';

/** What was found in the official index, or the download of one package, changed. */
export const extensionsFound = defineEvent('core.extensions.found', z.object({}), {
	audience: CORE_CAPABILITIES.extensionsManage.id,
});

const KEY = 'extension_index';
export const FIND_JOB = 'core.fetchExtensionIndex';
export const DOWNLOAD_JOB = 'core.fetchExtensionPackage';

/**
 * Why looking or downloading failed, from the `details` of the error, for a page to say:
 * - looking: `unreachable` (no answer, not 200, a redirect, too slow), `missing` (the host has no
 *   index: 404 or 410), `unsigned` (the index's signature is missing, by an unknown key or wrong),
 *   `invalid` (not an index this server reads);
 * - downloading: `unreachable`, `missing` (the index lists a file its host does not have),
 *   `mismatch` (size or SHA-256 differ from the index), `reach_changed` (the package reaches
 *   something other than the index said), `gone` (the
 *   index no longer lists it), or what an uploaded file would be refused for (`too_large`,
 *   `unsigned`, `incompatible`, `invalid` with a `code`; `older` with `version`);
 * - `failed`: anything else (the server's log says why).
 */
export const ExtensionFindProblemSchema = z.object({
	reason: z.string(),
	code: z.string().nullable(),
	params: ProblemParamsSchema,
});
type Problem = z.infer<typeof ExtensionFindProblemSchema>;

/** The last search of the index. */
export const ExtensionSearchSchema = z.object({
	status: z.enum(['looking', 'done', 'failed']),
	at: z.number(),
	problem: ExtensionFindProblemSchema.nullable(),
});

/** The last download of a package the index lists. */
export const ExtensionDownloadSchema = z.object({
	id: z.string(),
	version: z.string(),
	status: z.enum(['downloading', 'ready', 'failed']),
	at: z.number(),
	problem: ExtensionFindProblemSchema.nullable(),
});
export type ExtensionDownload = z.infer<typeof ExtensionDownloadSchema>;

const StateSchema = z.object({
	search: ExtensionSearchSchema.nullable(),
	/** What the index listed at the last search that worked. */
	packages: z.array(IndexedPackageSchema),
	/** With the staged package's digest once it is ready. */
	download: ExtensionDownloadSchema.extend({ digest: z.string().nullable() }).nullable(),
});
type State = z.infer<typeof StateSchema>;

const empty = (): State => ({ search: null, packages: [], download: null });

async function readState(db: DbExecutor): Promise<State> {
	const parsed = StateSchema.safeParse(await readJson<unknown>(db, KEY, null));
	return parsed.success ? parsed.data : empty();
}

/** A problem from what a port threw: its reason, code and the plain values its sentence names. */
function problemOf(error: unknown): Problem {
	if (!isFamosError(error)) return { reason: 'failed', code: null, params: {} };
	const details = (error.details ?? {}) as Record<string, unknown>;
	const params: Record<string, string> = {};
	for (const [name, value] of Object.entries(details))
		if (name !== 'reason' && name !== 'code' && typeof value === 'string')
			params[name] = value.slice(0, 200);
	return {
		reason: typeof details.reason === 'string' ? details.reason : 'failed',
		code: typeof details.code === 'string' ? details.code : null,
		params,
	};
}

/**
 * A package the index has that this server does not: an extension it has no package of, or a
 * newer version than the one it has. Only the newest version of each that this server can run.
 */
export const FoundExtensionSchema = z.object({
	id: z.string(),
	version: z.string(),
	/** The version this server has a package of, or null when it has none. */
	current: z.string().nullable(),
	size: z.number(),
	labels: z.record(z.string(), z.object({ name: z.string(), description: z.string() })),
	/** What it reaches, from the signed index, so the family sees it before downloading. */
	reach: IndexReachSchema.optional(),
});
export type FoundExtension = z.infer<typeof FoundExtensionSchema>;

/** The newest version of each package this server can run and has no package that new of. */
export function newerThanHere(
	packages: readonly IndexedPackage[],
	here: ReadonlyMap<string, string>,
): FoundExtension[] {
	const best = new Map<string, IndexedPackage>();
	for (const pkg of packages) {
		if (!satisfiesCaret(SDK_VERSION, pkg.sdk)) continue;
		const have = best.get(pkg.id);
		if (!have || compareVersions(pkg.version, have.version) > 0) best.set(pkg.id, pkg);
	}
	return [...best.values()]
		.filter((pkg) => {
			const current = here.get(pkg.id);
			return current === undefined || compareVersions(pkg.version, current) > 0;
		})
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((pkg) => ({
			id: pkg.id,
			version: pkg.version,
			current: here.get(pkg.id) ?? null,
			size: pkg.size,
			labels: pkg.labels,
			...(pkg.reach && { reach: pkg.reach }),
		}));
}

export interface ExtensionFindDeps {
	packages: () => ExtensionPackagesPort;
	/** Refuses anyone but a person signed in to the app (or the command line). */
	assertPerson: (actor: Actor, what: string) => void;
}

/**
 * Looking for more extensions in the official index, and downloading one. Both reach the
 * internet, so they happen only when a person asks (never on a schedule or at start), as jobs:
 * the index is fetched and its signature checked, a download is checked against the index and
 * staged like an uploaded file, and installing it is then the same `core.installExtension` as
 * for a file.
 */
export function createExtensionFind(deps: ExtensionFindDeps) {
	const save = (db: DbExecutor, state: State, now: number) => writeJson(db, KEY, state, now);

	const find = defineAction({
		id: 'core.findExtensions',
		title: 'Look for more extensions in the official index',
		input: z.object({}),
		output: z.object({ queued: z.literal(true) }),
		requires: CORE_CAPABILITIES.extensionsManage.id,
		approval: 'never',
		async run(uow) {
			deps.assertPerson(uow.actor, 'look for extensions');
			if (!deps.packages().findPackages)
				throw new FamosError('bad_request', 'This server cannot look for extensions online');
			const now = uow.clock.now();
			const state = await readState(uow.db);
			await save(uow.db, { ...state, search: { status: 'looking', at: now, problem: null } }, now);
			// The index is on the internet: a job fetches it, never the request.
			await uow.enqueue(FIND_JOB, {});
			uow.emit(extensionsFound, {});
			return { queued: true as const };
		},
	});

	const download = defineAction({
		id: 'core.downloadExtension',
		title: 'Download an extension the official index lists, to install it',
		input: z.object({
			extensionId: z.string().max(64),
			version: z.string().max(32),
		}),
		output: z.object({ queued: z.literal(true) }),
		requires: CORE_CAPABILITIES.extensionsManage.id,
		approval: 'never',
		async run(uow, input) {
			deps.assertPerson(uow.actor, 'download extensions');
			if (!deps.packages().download)
				throw new FamosError('bad_request', 'This server cannot download extensions');
			const state = await readState(uow.db);
			const listed = state.packages.some(
				(p) => p.id === input.extensionId && p.version === input.version,
			);
			if (!listed)
				throw new FamosError(
					'not_found',
					`The index does not list ${input.extensionId} ${input.version}; look again`,
				);
			const now = uow.clock.now();
			await save(
				uow.db,
				{
					...state,
					download: {
						id: input.extensionId,
						version: input.version,
						status: 'downloading',
						at: now,
						digest: null,
						problem: null,
					},
				},
				now,
			);
			await uow.enqueue(DOWNLOAD_JOB, { extensionId: input.extensionId, version: input.version });
			uow.emit(extensionsFound, {});
			return { queued: true as const };
		},
	});

	const fetchIndex = defineJob({
		name: FIND_JOB,
		payload: z.object({}),
		maxAttempts: 2,
		timeoutMs: 60_000,
		async handle(ctx) {
			const at = ctx.clock.now();
			let next: Partial<State>;
			try {
				const port = deps.packages();
				if (!port.findPackages) throw new FamosError('bad_request', 'This server cannot look');
				next = {
					search: { status: 'done', at, problem: null },
					packages: await port.findPackages(),
				};
			} catch (error) {
				// Said on the page; looking again is the person's choice, so nothing is retried.
				const problem = problemOf(error);
				ctx.logger.warn({ reason: problem.reason }, 'looking for extensions failed');
				next = { search: { status: 'failed', at, problem } };
			}
			await save(ctx.db, { ...(await readState(ctx.db)), ...next }, at);
			ctx.events.emit(extensionsFound, {});
		},
	});

	const fetchPackage = defineJob({
		name: DOWNLOAD_JOB,
		payload: z.object({ extensionId: z.string(), version: z.string() }),
		maxAttempts: 2,
		// A package can weigh 20 MB on a slow line: it must not hold up reminders.
		lane: 'long',
		timeoutMs: 180_000,
		async handle(ctx, payload) {
			const at = ctx.clock.now();
			const entry = (await readState(ctx.db)).packages.find(
				(p) => p.id === payload.extensionId && p.version === payload.version,
			);
			let result: { digest: string | null; problem: Problem | null };
			try {
				if (!entry)
					throw new FamosError('not_found', 'The index no longer lists it', { reason: 'gone' });
				const port = deps.packages();
				if (!port.download) throw new FamosError('bad_request', 'This server cannot download');
				// Staging is idempotent (by digest), so a second attempt after a crash is harmless.
				result = { digest: (await port.download(entry)).digest, problem: null };
			} catch (error) {
				const problem = problemOf(error);
				ctx.logger.warn(
					{ extension: payload.extensionId, version: payload.version, reason: problem.reason },
					'downloading an extension failed',
				);
				result = { digest: null, problem };
			}
			const state = await readState(ctx.db);
			// A download asked for since this one started is the one the page waits for.
			const current = state.download;
			if (current && (current.id !== payload.extensionId || current.version !== payload.version))
				return;
			await save(
				ctx.db,
				{
					...state,
					download: {
						id: payload.extensionId,
						version: payload.version,
						status: result.digest ? 'ready' : 'failed',
						at,
						...result,
					},
				},
				at,
			);
			ctx.events.emit(extensionsFound, {});
		},
	});

	return {
		actions: [find, download],
		jobs: [fetchIndex, fetchPackage],
		events: [extensionsFound],
		/**
		 * The last search, what it found that this server lacks, and the last download with its
		 * staged package (checked again; null once it is gone: staged packages nobody installed
		 * are removed after a day).
		 */
		async describe(db: DbExecutor): Promise<{
			search: z.infer<typeof ExtensionSearchSchema> | null;
			found: FoundExtension[];
			download: (ExtensionDownload & { staged: StagedPackage | null }) | null;
		}> {
			const state = await readState(db);
			const port = deps.packages();
			const here = new Map(port.list().map((p) => [p.id, p.version] as const));
			let download: (ExtensionDownload & { staged: StagedPackage | null }) | null = null;
			if (state.download) {
				const { digest, ...rest } = state.download;
				// A staged copy that no longer passes its check is as good as gone.
				const staged = digest
					? await (port.staged?.(digest) ?? Promise.resolve(undefined)).catch(() => undefined)
					: undefined;
				download = { ...rest, staged: staged ?? null };
			}
			// Only what the last search found: while looking, or after it failed, nothing is offered.
			const found = state.search?.status === 'done' ? newerThanHere(state.packages, here) : [];
			return { search: state.search, found, download };
		},
	};
}
