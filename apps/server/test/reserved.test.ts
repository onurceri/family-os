import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { RESERVED_TABLE_PREFIXES, tablePrefixOf } from '@famos/sdk';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { migrate, openRuntime } from '../src/runtime.ts';

/**
 * Every table the host itself creates (core and each infrastructure adapter) lies under a reserved
 * prefix, so no extension can be given a prefix that reaches it. An adapter added with tables
 * under a new name fails here until the name is reserved.
 */
it('keeps every host table under a reserved prefix', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-reserved-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: 'http://localhost' });
	const runtime = openRuntime(config, { logger: silentLogger, quiet: true });
	try {
		await migrate(runtime);
		const extensionPrefixes = runtime.kernel.registry.extensions
			.filter((e) => e.id !== 'core')
			.map((e) => tablePrefixOf(e.manifest));
		const tables = runtime.handle.sqlite
			.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`)
			.all() as { name: string }[];
		const unreserved = tables
			.map((t) => t.name)
			.filter((name) => name !== '_migrations')
			.filter((name) => !extensionPrefixes.some((p) => name.startsWith(p)))
			.filter((name) => !RESERVED_TABLE_PREFIXES.some((p) => name.startsWith(p)));
		expect(unreserved).toEqual([]);
	} finally {
		await runtime.close();
	}
});
