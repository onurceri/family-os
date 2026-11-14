import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

/**
 * A database made by the last release (fixtures/README.md says how), with every extension that
 * release ships installed and a small made-up family in it. It upgrades with today's code and
 * ends up shaped exactly like a database today's code migrated from nothing: a released
 * migration that was edited, renamed or dropped shows up here, because only a fresh database
 * gets the edited version.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures/release-0.10.0.sqlite');
/** The key the fixture was made with; the fixture holds no other secret. */
const FIXTURE_SECRET = 'famos-upgrade-fixture-secret-0.10.0-not-a-real-key';

const runtimes: Runtime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function open(from?: string): Promise<Runtime> {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-release-'));
	if (from) await copyFile(from, join(dataDir, 'famos.db'));
	const config = await loadConfig({
		FAMOS_DATA_DIR: dataDir,
		FAMOS_BASE_URL: 'http://localhost',
		FAMOS_SECRET: FIXTURE_SECRET,
	});
	const runtime = openRuntime(config, { extensions, logger: silentLogger, quiet: true });
	runtimes.push(runtime);
	return runtime;
}

/**
 * Tables as their columns and foreign keys; indexes, triggers and views as their SQL. A table's
 * own SQL is not compared: a column added later is appended to it, so the same shape reads
 * differently from a table created whole.
 */
function schemaOf(runtime: Runtime): Record<string, unknown> {
	const { sqlite } = runtime.handle;
	const objects = sqlite
		.prepare(
			`select type, name, sql from sqlite_master
			where name not like 'sqlite_%' and name != '_migrations' order by type, name`,
		)
		.all() as { type: string; name: string; sql: string | null }[];
	const schema: Record<string, unknown> = {};
	for (const { type, name, sql } of objects) {
		if (type === 'table') {
			schema[`table ${name}`] = {
				columns: sqlite
					.prepare(
						'select name, type, "notnull", dflt_value, pk, hidden from pragma_table_xinfo(?)',
					)
					.all(name),
				foreignKeys: sqlite
					.prepare(
						'select "table", "from", "to", on_update, on_delete from pragma_foreign_key_list(?)',
					)
					.all(name),
			};
		} else {
			schema[`${type} ${name}`] = (sql ?? '').replace(/\s+/g, ' ').trim();
		}
	}
	return schema;
}

it('upgrades the previous release’s database, every migration it applied still in the code', async () => {
	const runtime = await open(FIXTURE);
	const applied = runtime.handle.sqlite
		.prepare('select scope, name from _migrations order by scope, name')
		.all() as { scope: string; name: string }[];
	expect(applied.length).toBeGreaterThan(0);
	const missing = applied
		.filter(
			({ scope, name }) =>
				!runtime.kernel.migrationScopes.find((s) => s.scope === scope)?.migrations[name],
		)
		.map(({ scope, name }) => `${scope}/${name}`);
	expect(missing).toEqual([]);

	expect(await migrate(runtime)).toBeGreaterThan(0);
	await runtime.kernel.start();

	// What the family put in is still there, read the way the app reads it.
	const read = async (id: string) => {
		const route = runtime.kernel.registry.routes.find((r) => r.route.operationId === id);
		if (!route) throw new Error(`${id} is missing`);
		return (await route.route.handle(runtime.kernel.contextFor(id.split('.')[0] as string), {
			params: {},
			query: undefined,
			body: undefined,
			actor: { kind: 'system', source: 'test' },
			device: null,
			files: [],
		})) as unknown[];
	};
	const tasks = (await read('lists.listTasks')) as { title: string }[];
	expect(tasks.map((t) => t.title)).toContain('Return library books');
	expect((await read('lists.listShoppingLists')).length).toBeGreaterThan(0);
	expect(await runtime.kernel.contextFor('lists').family.members()).toHaveLength(4);
	const events = runtime.handle.sqlite.prepare('select title from calendar_events').all() as {
		title: string;
	}[];
	expect(events.map((e) => e.title)).toContain('Dentist');
});

it('ends up with the schema of a database migrated from nothing', async () => {
	const upgraded = await open(FIXTURE);
	await migrate(upgraded);
	const fresh = await open();
	await migrate(fresh);
	expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
});
