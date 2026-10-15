import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { readExtensionState } from '@famos/core';
import { MigrationFailedError, openDatabase, runMigrations } from '@famos/db';
import {
	defineExtension,
	type ExtensionDefinition,
	parseManifest,
	SDK_VERSION,
	systemActor,
} from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
	type InstalledExtensions,
	loadInstalled,
	recordFailure,
	recordStart,
} from '../src/extensions/installed.ts';
import type { Available, AvailableExtension } from '../src/extensions/load.ts';
import { chooseInstalled, migrationProblem } from '../src/extensions/state.ts';
import { migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const LIST = JSON.parse(
	readFileSync(join(import.meta.dirname, '../../../extensions.json'), 'utf8'),
) as Available['list'];
const ALWAYS = [...LIST.always].sort();
/** What a new family starts with: the core set and the defaults (photos and weather). */
const FRESH = [...LIST.always, ...LIST.default].sort();
const ALL = [...LIST.always, ...LIST.offered].sort();
const workspace = await discoverSourceExtensions();

/** The shipped packages, as the server finds them, from the workspace's definitions. */
function available(
	extra: {
		def: ExtensionDefinition;
		always?: boolean;
		load?: () => Promise<ExtensionDefinition>;
	}[] = [],
): Available {
	const always = new Set(LIST.always);
	const entry = (
		def: ExtensionDefinition,
		isAlways: boolean,
		load = async () => def,
	): AvailableExtension => ({
		id: def.id,
		version: def.manifest.version,
		always: isAlways,
		manifest: parseManifest(def.manifest),
		labels: { en: { name: def.id, description: def.id } },
		load,
		web: () => undefined,
	});
	return {
		from: 'bundled',
		dir: '/nonexistent',
		list: { ...LIST, offered: [...LIST.offered, ...extra.map((e) => e.def.id)] },
		extensions: [
			...workspace.map((def) => entry(def, always.has(def.id))),
			...extra.map((e) => entry(e.def, e.always === true, e.load)),
		],
		unreadable: [],
	};
}

const runtimes: Runtime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
});

/** One start of the server on `dataDir`: choose, load, open, migrate, record. */
async function start(dataDir: string, from: Available = available()) {
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: 'http://localhost' });
	const handle = openDatabase({ path: config.dbPath });
	const selection = await loadInstalled(handle.db, from);
	const runtime = openRuntime(config, {
		extensions: selection.extensions,
		handle,
		extensionPackages: selection.packages,
		refusable: selection.refusable,
		refused: selection.refused,
		logger: silentLogger,
		quiet: true,
	});
	runtimes.push(runtime);
	await migrate(runtime);
	await recordStart(handle.db, selection, runtime.kernel.registry.extensions, Date.now());
	return { runtime, selection };
}
async function stop(runtime: Runtime) {
	runtimes.splice(runtimes.indexOf(runtime), 1);
	await runtime.close();
}
const ids = (selection: InstalledExtensions) => selection.extensions.map((e) => e.id).sort();
const newDataDir = () => mkdtemp(join(tmpdir(), 'famos-installed-'));

describe('choosing what to load', () => {
	const shipped = ALL.map((id) => ({ id, always: LIST.always.includes(id) }));

	it('gives a new family the core set and what is installed by default', () => {
		expect(
			chooseInstalled({
				state: null,
				scopes: {},
				available: shipped,
				defaults: [],
				fromSource: false,
			}),
		).toEqual(ALWAYS);
		expect(
			chooseInstalled({
				state: null,
				scopes: {},
				available: shipped,
				defaults: ['pets'],
				fromSource: false,
			}),
		).toEqual([...ALWAYS, 'pets'].sort());
	});

	it('keeps every extension with data for a family from before installing', () => {
		const scopes = Object.fromEntries([
			['core', ['0001']],
			...ALL.map((id) => [id, ['0001_init']]),
		]);
		expect(
			chooseInstalled({ state: null, scopes, available: shipped, defaults: [], fromSource: false }),
		).toEqual(ALL);
	});

	it('follows the stored state, adding what is always there', () => {
		const state = { installed: ['pets'], known: {}, failed: [], restartRequestedAt: null };
		expect(
			chooseInstalled({ state, scopes: {}, available: shipped, defaults: [], fromSource: true }),
		).toEqual([...ALWAYS, 'pets'].sort());
	});

	it('runs everything from workspace source when nothing was chosen', () => {
		expect(
			chooseInstalled({
				state: null,
				scopes: {},
				available: shipped,
				defaults: [],
				fromSource: true,
			}),
		).toEqual(ALL);
	});

	it('finds migrations a package cannot run', () => {
		const m = { '0001_init': { up: async () => {} }, '0002_more': { up: async () => {} } };
		expect(migrationProblem(undefined, m)).toBeNull();
		expect(migrationProblem(['0001_init'], m)).toBeNull();
		expect(migrationProblem(['0001_init', '0003_newer'], m)).toMatch(/newer version/);
		const gap = { ...m, '0003_last': { up: async () => {} } };
		expect(migrationProblem(['0001_init', '0003_last'], gap)).toMatch(/0002_more sorts before/);
	});
});

describe('starting with the installed set', () => {
	it('starts a new family with the core set and the defaults, and remembers it', async () => {
		const { runtime, selection } = await start(await newDataDir());
		expect(LIST.default).toEqual(['ambient']);
		expect(ids(selection)).toEqual(FRESH);
		expect(runtime.kernel.registry.extensions.map((e) => e.id).sort()).toEqual(
			['core', ...FRESH].sort(),
		);
		const state = await readExtensionState(runtime.handle.db);
		expect(state?.installed).toEqual(FRESH);
		expect(Object.keys(state?.known ?? {}).sort()).toEqual(FRESH);
		expect(state?.known.records).toEqual({ tablePrefix: 'records_', version: '0.1.0' });
	});

	it('keeps all twelve for a family that upgrades', async () => {
		const dataDir = await newDataDir();
		// The release before: every extension ran, and no installed set was stored.
		const config = await loadConfig({
			FAMOS_DATA_DIR: dataDir,
			FAMOS_BASE_URL: 'http://localhost',
		});
		const before = openRuntime(config, {
			extensions: workspace,
			logger: silentLogger,
			quiet: true,
		});
		await runMigrations(before.handle.db, before.kernel.migrationScopes);
		await before.close();

		const { runtime, selection } = await start(dataDir);
		expect(ids(selection)).toEqual(ALL);
		expect(selection.refused).toEqual([]);
		expect((await readExtensionState(runtime.handle.db))?.installed).toEqual(ALL);
	});

	it('loads an installed extension at the next start, with what it needs', async () => {
		const dataDir = await newDataDir();
		const first = await start(dataDir);
		const result = await first.runtime.kernel.runner.invoke(
			'core.installExtension',
			{ extensionId: 'pets' },
			systemActor('cli'),
		);
		expect(result).toMatchObject({ status: 'applied', output: { changed: ['pets'] } });
		await stop(first.runtime);

		const second = await start(dataDir);
		expect(ids(second.selection)).toContain('pets');
		const list = await second.runtime.kernel.listExtensions();
		expect(list.restartNeeded).toBe(false);
		expect(list.extensions.find((e) => e.id === 'pets')?.status).toBe('loaded');
	});

	it('keeps the data and jobs of an uninstalled extension, and starts without it', async () => {
		const dataDir = await newDataDir();
		const first = await start(dataDir);
		const cli = systemActor('cli');
		await first.runtime.kernel.runner.invoke('core.installExtension', { extensionId: 'pets' }, cli);
		await stop(first.runtime);
		const second = await start(dataDir);
		const { kernel } = second.runtime;
		const added = await kernel.runner.invoke('pets.addPet', { name: 'Pamuk', species: 'cat' }, cli);
		expect(added.status).toBe('applied');
		await second.runtime.queue.enqueue(second.runtime.handle.db, 'pets.later', {});
		await kernel.runner.invoke('core.uninstallExtension', { extensionId: 'pets' }, cli);
		await stop(second.runtime);

		const third = await start(dataDir);
		expect(ids(third.selection)).not.toContain('pets');
		const db = third.runtime.handle.db;
		const pets = await db
			.selectFrom('pets_pets' as never)
			.selectAll()
			.execute();
		expect(pets).toHaveLength(1);
		const jobs = await db
			.selectFrom('queue_jobs' as never)
			.select(['name' as never, 'status' as never])
			.where('name' as never, '=', 'pets.later' as never)
			.execute();
		expect(jobs).toEqual([{ name: 'pets.later', status: 'pending' }]);
		await third.runtime.kernel.start();
		const list = await third.runtime.kernel.listExtensions();
		expect(list.extensions.find((e) => e.id === 'pets')?.status).toBe('available');
		// Installing it again brings the same data back.
		await third.runtime.kernel.runner.invoke('core.installExtension', { extensionId: 'pets' }, cli);
		await stop(third.runtime);
		const fourth = await start(dataDir);
		expect(ids(fourth.selection)).toContain('pets');
		expect(
			await fourth.runtime.handle.db
				.selectFrom('pets_pets' as never)
				.selectAll()
				.execute(),
		).toHaveLength(1);
	});

	it('refuses only the package whose migrations the database has outgrown', async () => {
		const dataDir = await newDataDir();
		const first = await start(dataDir);
		await first.runtime.kernel.runner.invoke(
			'core.installExtension',
			{ extensionId: 'pets' },
			systemActor('cli'),
		);
		await stop(first.runtime);
		const second = await start(dataDir);
		second.runtime.handle.sqlite
			.prepare(
				"insert into _migrations (scope, name, applied_at) values ('pets', '9999_future', 1)",
			)
			.run();
		await stop(second.runtime);

		const third = await start(dataDir);
		expect(ids(third.selection)).toEqual(FRESH);
		expect(third.selection.refused).toEqual([
			{ id: 'pets', version: '0.1.0', reason: expect.stringMatching(/9999_future.*newer version/) },
		]);
		await third.runtime.kernel.start();
		const list = await third.runtime.kernel.listExtensions();
		expect(list.extensions.find((e) => e.id === 'pets')).toMatchObject({
			status: 'refused',
			reason: expect.stringContaining('9999_future'),
		});
	});

	it('starts without an offered package that is broken, and stops for one always there', async () => {
		const confused = defineExtension({
			manifest: {
				id: 'confused',
				version: '0.1.0',
				sdk: `^${SDK_VERSION}`,
				calls: ['core.nothing'],
			},
		});
		const unloadable = defineExtension({
			manifest: { id: 'unloadable', version: '0.1.0', sdk: `^${SDK_VERSION}` },
		});
		const from = available([
			{ def: confused },
			{
				def: unloadable,
				load: async () => {
					throw new Error('imports something odd');
				},
			},
		]);
		const dataDir = await newDataDir();
		const first = await start(dataDir, from);
		const cli = systemActor('cli');
		for (const extensionId of ['confused', 'unloadable'])
			await first.runtime.kernel.runner.invoke('core.installExtension', { extensionId }, cli);
		await stop(first.runtime);

		const second = await start(dataDir, from);
		await second.runtime.kernel.start();
		expect(second.runtime.kernel.registry.extensions.map((e) => e.id)).not.toContain('confused');
		expect(second.runtime.kernel.refused).toEqual([
			{ id: 'unloadable', version: '0.1.0', reason: 'imports something odd' },
			{ id: 'confused', version: '0.1.0', reason: expect.stringContaining('core.nothing') },
		]);
		await stop(second.runtime);

		const alwaysBroken = available([
			{
				def: unloadable,
				always: true,
				load: async () => {
					throw new Error('imports something odd');
				},
			},
		]);
		await expect(start(await newDataDir(), alwaysBroken)).rejects.toThrow('imports something odd');
	});

	it('does not load a package again whose migration failed, until a new version comes', async () => {
		const boom = defineExtension({
			manifest: { id: 'boom', version: '0.1.0', sdk: `^${SDK_VERSION}` },
			migrations: {
				'0001_init': {
					up: async () => {
						throw new Error('disk says no');
					},
				},
			},
		});
		const dataDir = await newDataDir();
		const first = await start(dataDir, available([{ def: boom }]));
		await first.runtime.kernel.runner.invoke(
			'core.installExtension',
			{ extensionId: 'boom' },
			systemActor('cli'),
		);
		await stop(first.runtime);

		// The start that loads it fails in its migration; the server records it and exits.
		const error = await start(dataDir, available([{ def: boom }])).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(MigrationFailedError);
		expect(error).toMatchObject({ scope: 'boom' });
		const handle = openDatabase({
			path: (await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: 'http://x' })).dbPath,
		});
		await recordFailure(handle.db, { id: 'boom', version: '0.1.0', reason: 'disk says no' }, 5);
		await handle.close();

		const next = await start(dataDir, available([{ def: boom }]));
		expect(ids(next.selection)).not.toContain('boom');
		expect(next.selection.refused).toEqual([
			{ id: 'boom', version: '0.1.0', reason: 'disk says no' },
		]);
		const list = await next.runtime.kernel.listExtensions();
		expect(list.extensions.find((e) => e.id === 'boom')).toMatchObject({
			status: 'failed',
			reason: 'disk says no',
		});
		await stop(next.runtime);

		// A new version of the package is tried again.
		const fixed = defineExtension({
			manifest: { id: 'boom', version: '0.1.1', sdk: `^${SDK_VERSION}` },
			migrations: { '0001_init': { up: async () => {} } },
		});
		const later = await start(dataDir, available([{ def: fixed }]));
		expect(ids(later.selection)).toContain('boom');
		expect((await readExtensionState(later.runtime.handle.db))?.failed).toEqual([]);
	});
});
