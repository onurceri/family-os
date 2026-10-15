import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { type ExtensionPackage, type ExtensionState, readExtensionState } from '@famos/core';
import { openDatabase } from '@famos/db';
import { parseManifest, systemActor } from '@famos/sdk';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { loadInstalled, recordStart } from '../src/extensions/installed.ts';
import type { Available, AvailableExtension } from '../src/extensions/load.ts';
import { describePurge, purgeExtension, purgeTarget } from '../src/extensions/purge.ts';
import { migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const LIST = JSON.parse(
	readFileSync(join(import.meta.dirname, '../../../extensions.json'), 'utf8'),
) as Available['list'];
const workspace = await discoverSourceExtensions();

function available(): Available {
	const always = new Set(LIST.always);
	return {
		from: 'bundled',
		dir: '/nonexistent',
		list: LIST,
		extensions: workspace.map(
			(def): AvailableExtension => ({
				id: def.id,
				version: def.manifest.version,
				always: always.has(def.id),
				manifest: parseManifest(def.manifest),
				labels: { en: { name: def.id, description: def.id } },
				load: async () => def,
				web: () => undefined,
			}),
		),
		unreadable: [],
	};
}

const runtimes: Runtime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
});

/** One start of the server on `dataDir`: choose, load, open, migrate, record. */
async function start(dataDir: string) {
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: 'http://localhost' });
	const handle = openDatabase({ path: config.dbPath });
	const selection = await loadInstalled(handle.db, available());
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

const cli = systemActor('cli');
const NOW = 1_700_000_000_000;

async function names(runtime: Runtime, prefix: string) {
	const { rows } = await sql<{ name: string }>`select name from sqlite_master
		where substr(name, 1, ${prefix.length}) = ${prefix}`.execute(runtime.handle.db);
	return rows.map((r) => r.name);
}
async function rows<T>(runtime: Runtime, query: string): Promise<T[]> {
	return (await sql<T>`${sql.raw(query)}`.execute(runtime.handle.db)).rows;
}
async function setting(runtime: Runtime, table: string, key: string): Promise<unknown> {
	const [row] = await rows<{ value: string }>(
		runtime,
		`select value from ${table} where key = '${key}'`,
	);
	return row ? JSON.parse(row.value) : undefined;
}

/** Rows and settings the host keeps about pets and, beside them, about others that must stay. */
async function seedHostRows(runtime: Runtime) {
	const db = runtime.handle.db;
	const json = (value: unknown) => JSON.stringify(value);
	await sql`insert into core_members (id, display_name, role_id, color, created_at, updated_at)
		values ('mem_1', 'Deniz', 'admin', 'c1', ${NOW}, ${NOW})`.execute(db);
	await sql`insert into core_roles (id, name, base, overrides, created_at, updated_at)
		values ('role_1', 'Sitter', 'guest', ${json({ 'pets.view': true, 'records.view': true })}, ${NOW}, ${NOW})`.execute(
		db,
	);
	const prefs = {
		kinds: { 'pets.due': { push: false }, 'chores.due': { push: false } },
		quietHours: null,
	};
	await sql`insert into core_notification_prefs (member_id, prefs, updated_at)
		values ('mem_1', ${json(prefs)}, ${NOW})`.execute(db);
	await sql`insert into core_notifications (id, member_id, kind, title_key, created_at)
		values ('ntf_1', 'mem_1', 'pets.due', 'pets:due', ${NOW}),
			('ntf_2', 'mem_1', 'chores.due', 'chores:due', ${NOW})`.execute(db);
	await sql`insert into core_drafts (id, action_id, input, status, proposed_by, created_at, updated_at)
		values ('drf_1', 'pets.addPet', '{}', 'pending', '{}', ${NOW}, ${NOW}),
			('drf_2', 'lists.addItem', '{}', 'pending', '{}', ${NOW}, ${NOW})`.execute(db);
	await sql`insert into core_idempotency (key, member_id, action_id, status, response, created_at)
		values ('k1', 'mem_1', 'pets.addPet', 200, '{}', ${NOW}),
			('k2', 'mem_1', 'lists.addItem', 200, '{}', ${NOW})`.execute(db);
	for (const [id, ext] of [
		['emb_1', 'pets'],
		['emb_2', 'records'],
	] as const)
		await sql`insert into core_embeddings (id, extension_id, source_kind, source_id, capability,
			title, href, snippet, model, dimensions, text_hash, chunk_index, vector, updated_at)
			values (${id}, ${ext}, ${`${ext}.thing`}, ${id}, ${`${ext}.view`}, 't', '/', 's', 'm', 1,
				'h', 0, x'00000000', ${NOW})`.execute(db);
	await sql`insert into core_file_grants (key, grantee, created_at)
		values ('pets/photo.jpg', 'records', ${NOW}), ('inbox/a.pdf', 'pets', ${NOW}),
			('inbox/b.pdf', 'records', ${NOW})`.execute(db);
	await sql`insert into core_devices (id, name, kind, token_hash, created_by, created_at,
		last_seen_at, display_capabilities)
		values ('dev_1', 'Hall', 'kiosk', 'hash', 'mem_1', ${NOW}, ${NOW},
			${json(['pets.view', 'calendar.view'])})`.execute(db);
	const settings: Record<string, unknown> = {
		features: { disabled: ['kitchen', 'pets'] },
		ai_areas: { pets: 'off', kitchen: 'local' },
		'core.autoApproval': {
			'pets.addPet': { proposerCapability: 'core.ai.use', enabledBy: 'mem_1', enabledAt: NOW },
			'lists.addItem': { proposerCapability: 'pets.edit', enabledBy: 'mem_1', enabledAt: NOW },
			'calendar.createEvent': {
				proposerCapability: 'calendar.edit',
				enabledBy: 'mem_1',
				enabledAt: NOW,
			},
		},
		search_index: { built: { pets: 'm', records: 'm' }, lastError: null },
		'today.hidden': {
			family: ['pets', 'kitchen'],
			members: { mem_1: ['pets.due', 'calendar'] },
			displays: {},
		},
	};
	for (const [key, value] of Object.entries(settings))
		await sql`insert into core_settings (key, value, updated_at) values (${key}, ${json(value)}, ${NOW})
			on conflict (key) do update set value = excluded.value`.execute(db);
	await sql`insert into ai_settings (key, value, updated_at)
		values ('switches', ${json({ enabled: true, off: ['pets.describe', 'inbox.extract'] })}, ${NOW})
		on conflict (key) do update set value = excluded.value`.execute(db);
	await runtime.queue.enqueue(db, 'pets.later', {});
	await runtime.queue.enqueue(db, 'kitchen.later', {});
	// A view and an index of its own, which its tables alone would not account for.
	await sql`create view pets_names as select name from pets_pets`.execute(db);
	await sql`create index pets_pets_name_idx on pets_pets (name)`.execute(db);
}

async function writeFiles(filesDir: string) {
	await mkdir(join(filesDir, 'pets', 'photos'), { recursive: true });
	await writeFile(join(filesDir, 'pets', 'photos', 'pamuk.jpg'), 'jpg');
	await writeFile(join(filesDir, 'pets', 'card.pdf'), 'pdf');
	await mkdir(join(filesDir, 'kitchen'), { recursive: true });
	await writeFile(join(filesDir, 'kitchen', 'soup.jpg'), 'jpg');
}

describe('purging an uninstalled extension', () => {
	it('removes all of its data and nothing else, and it can be installed again fresh', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'famos-purge-'));
		const first = await start(dataDir);
		for (const ext of (await first.runtime.kernel.listExtensions()).extensions)
			if (ext.status === 'available')
				await first.runtime.kernel.runner.invoke(
					'core.installExtension',
					{ extensionId: ext.id },
					cli,
				);
		await stop(first.runtime);

		const second = await start(dataDir);
		const all = second.runtime.kernel.registry.extensions.map((e) => e.id);
		expect(all).toEqual(expect.arrayContaining(['pets', 'kitchen', 'home', 'vehicles']));
		const added = await second.runtime.kernel.runner.invoke(
			'pets.addPet',
			{ name: 'Pamuk', species: 'cat' },
			cli,
		);
		expect(added.status).toBe('applied');
		await seedHostRows(second.runtime);
		await writeFiles(second.runtime.config.filesDir);
		await second.runtime.kernel.runner.invoke(
			'core.uninstallExtension',
			{ extensionId: 'pets' },
			cli,
		);
		// Uninstalled, but the server that loaded it has not started again: it still uses it.
		const before = await readExtensionState(second.runtime.handle.db);
		expect(before?.loaded).toContain('pets');
		expect(() =>
			purgeTarget('pets', {
				state: before,
				installed: [],
				loaded: [],
				packages: second.selection.packages.list(),
			}),
		).toThrow('pets is still running. Restart FamilyOS first so it stops using pets');
		await stop(second.runtime);

		const third = await start(dataDir);
		const { runtime, selection } = third;
		expect(runtime.kernel.registry.extensions.map((e) => e.id)).not.toContain('pets');
		const kitchenTables = await names(runtime, 'kitchen_');
		const recordsTables = await names(runtime, 'records_');
		expect(kitchenTables.length).toBeGreaterThan(0);

		const target = purgeTarget('pets', {
			state: await readExtensionState(runtime.handle.db),
			installed: selection.installed,
			loaded: runtime.kernel.registry.extensions.map((e) => e.id),
			packages: selection.packages.list(),
		});
		expect(target).toEqual({ id: 'pets', tablePrefix: 'pets_' });
		const summary = await purgeExtension(runtime.handle, target, {
			filesDir: runtime.config.filesDir,
			now: NOW + 1,
		});
		expect(summary.tables).toContain('pets_pets');
		expect(summary.views).toEqual(['pets_names']);
		expect(summary.indexes).toContain('pets_pets_name_idx');
		expect(summary.migrations).toBeGreaterThan(0);
		expect(summary.files).toBe(2);
		expect(summary.rows).toEqual({
			jobs: 1,
			drafts: 1,
			notifications: 1,
			'answers kept for retried requests': 1,
			'search index entries': 1,
			'file grants': 2,
		});
		expect(describePurge('pets', summary)[0]).toBe('Removed the data of pets:');

		expect(await names(runtime, 'pets_')).toEqual([]);
		expect(await names(runtime, 'kitchen_')).toEqual(kitchenTables);
		expect(await names(runtime, 'records_')).toEqual(recordsTables);
		expect(await rows(runtime, `select name from _migrations where scope = 'pets'`)).toEqual([]);
		expect(
			(await rows(runtime, `select name from _migrations where scope = 'kitchen'`)).length,
		).toBeGreaterThan(0);
		expect(
			await rows(
				runtime,
				`select name from queue_jobs where name like 'pets.%' or name like 'kitchen.%'`,
			),
		).toEqual([{ name: 'kitchen.later' }]);
		expect(await rows(runtime, 'select id from core_drafts')).toEqual([{ id: 'drf_2' }]);
		expect(await rows(runtime, 'select id from core_notifications')).toEqual([{ id: 'ntf_2' }]);
		expect(await rows(runtime, 'select key from core_idempotency')).toEqual([{ key: 'k2' }]);
		expect(await rows(runtime, 'select id from core_embeddings')).toEqual([{ id: 'emb_2' }]);
		expect(await rows(runtime, 'select key, grantee from core_file_grants')).toEqual([
			{ key: 'inbox/b.pdf', grantee: 'records' },
		]);
		const [role] = await rows<{ overrides: string }>(
			runtime,
			`select overrides from core_roles where id = 'role_1'`,
		);
		expect(JSON.parse(role?.overrides ?? '')).toEqual({ 'records.view': true });
		const [prefs] = await rows<{ prefs: string }>(
			runtime,
			'select prefs from core_notification_prefs',
		);
		expect(JSON.parse(prefs?.prefs ?? '').kinds).toEqual({ 'chores.due': { push: false } });
		const [device] = await rows<{ display_capabilities: string }>(
			runtime,
			'select display_capabilities from core_devices',
		);
		expect(JSON.parse(device?.display_capabilities ?? '')).toEqual(['calendar.view']);
		expect(await setting(runtime, 'core_settings', 'features')).toEqual({ disabled: ['kitchen'] });
		expect(await setting(runtime, 'core_settings', 'ai_areas')).toEqual({ kitchen: 'local' });
		expect(
			Object.keys((await setting(runtime, 'core_settings', 'core.autoApproval')) as object),
		).toEqual(['calendar.createEvent']);
		expect(await setting(runtime, 'core_settings', 'search_index')).toEqual({
			built: { records: 'm' },
			lastError: null,
		});
		expect(await setting(runtime, 'core_settings', 'today.hidden')).toEqual({
			family: ['kitchen'],
			members: { mem_1: ['calendar'] },
			displays: {},
		});
		expect(await setting(runtime, 'ai_settings', 'switches')).toEqual({
			enabled: true,
			off: ['inbox.extract'],
		});
		const state = (await readExtensionState(runtime.handle.db)) as ExtensionState;
		expect(state.known.pets).toBeUndefined();
		expect(state.known.kitchen).toBeDefined();
		expect(await readdir(runtime.config.filesDir)).not.toContain('pets');
		expect(await readdir(join(runtime.config.filesDir, 'kitchen'))).toEqual(['soup.jpg']);
		expect(await rows(runtime, 'pragma foreign_keys')).toEqual([{ foreign_keys: 1 }]);

		// Installing it again starts it from nothing: its migrations run again.
		await runtime.kernel.runner.invoke('core.installExtension', { extensionId: 'pets' }, cli);
		await stop(runtime);
		const fourth = await start(dataDir);
		expect(fourth.runtime.kernel.registry.extensions.map((e) => e.id)).toContain('pets');
		expect(await rows(fourth.runtime, 'select * from pets_pets')).toEqual([]);
		expect(
			(await rows(fourth.runtime, `select name from _migrations where scope = 'pets'`)).length,
		).toBe(summary.migrations);
		expect((await readExtensionState(fourth.runtime.handle.db))?.known.pets).toEqual({
			tablePrefix: 'pets_',
			version: '0.1.0',
		});
	});
});

describe('what may not be purged', () => {
	const pkg = (id: string, always = false, tablePrefix?: string): ExtensionPackage => ({
		id,
		version: '0.1.0',
		always,
		manifest: parseManifest({
			id,
			version: '0.1.0',
			sdk: '^0.5.0',
			...(tablePrefix && { tablePrefix }),
		}),
		labels: {},
	});
	const known = (entries: Record<string, string>): ExtensionState => ({
		installed: ['records'],
		known: Object.fromEntries(
			Object.entries(entries).map(([id, tablePrefix]) => [id, { tablePrefix, version: '0.1.0' }]),
		),
		failed: [],
		restartRequestedAt: null,
	});
	const base = {
		state: known({ pets: 'pets_', records: 'records_' }),
		installed: ['records'],
		loaded: ['records'],
		packages: [pkg('records', true), pkg('pets')],
	};

	it('accepts an uninstalled extension that ran here', () => {
		expect(purgeTarget('pets', base)).toEqual({ id: 'pets', tablePrefix: 'pets_' });
	});

	it('refuses an always installed extension', () => {
		expect(() => purgeTarget('records', { ...base, installed: [] })).toThrow(/always installed/);
	});

	it('refuses an installed one', () => {
		expect(() => purgeTarget('pets', { ...base, installed: ['records', 'pets'] })).toThrow(
			/is installed/,
		);
		expect(() =>
			purgeTarget('pets', {
				...base,
				state: { ...base.state, installed: ['records', 'pets'] },
			}),
		).toThrow(/is installed/);
	});

	it('refuses one that still runs', () => {
		expect(() => purgeTarget('pets', { ...base, loaded: ['records', 'pets'] })).toThrow(
			/still running/,
		);
		// Loaded by the last start, which runs until the next one (a worker-only server too).
		expect(() =>
			purgeTarget('pets', {
				...base,
				state: { ...base.state, loaded: ['pets', 'records'] },
			}),
		).toThrow(/Restart FamilyOS first so it stops using pets/);
		// The last start ran without it.
		expect(purgeTarget('pets', { ...base, state: { ...base.state, loaded: ['records'] } })).toEqual(
			{ id: 'pets', tablePrefix: 'pets_' },
		);
	});

	it('refuses one with no recorded table prefix', () => {
		expect(() => purgeTarget('garden', base)).toThrow(/never ran/);
		expect(() => purgeTarget('pets', { ...base, state: null })).toThrow(/never ran/);
	});

	it("refuses a prefix that overlaps the host's", () => {
		for (const prefix of ['core_', 'core_x_', 'ai_', 'sqlite_', 'queue_jobs_'])
			expect(() => purgeTarget('odd', { ...base, state: known({ odd: prefix }) })).toThrow(
				/overlaps the host's/,
			);
	});

	it("refuses a prefix that overlaps another extension's", () => {
		expect(() =>
			purgeTarget('pets', { ...base, state: known({ pets: 'pets_', petsitter: 'pets_sitter_' }) }),
		).toThrow(/overlaps petsitter's "pets_sitter_"/);
		expect(() =>
			purgeTarget('pets', {
				...base,
				packages: [...base.packages, pkg('vet', false, 'pets_vet_')],
			}),
		).toThrow(/overlaps vet's/);
		// Prefixes that only share letters do not overlap.
		expect(
			purgeTarget('home', {
				...base,
				state: known({ home: 'home_', homework: 'homework_' }),
			}),
		).toEqual({ id: 'home', tablePrefix: 'home_' });
	});
});
