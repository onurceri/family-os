// Loads the extension packages in the folders given as arguments the way the built server does,
// in a Node process of its own (no Vitest module runner, so Node's own resolver and the host's
// import rules are what run), and prints the outcome as JSON. Used by loader.test.ts.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { z } from 'zod';
import { loadPackages } from '../../src/extensions/load.ts';

const dirs = process.argv.slice(2);
try {
	const loaded = await loadPackages(dirs);
	const shared = [];
	for (const dir of dirs) {
		const module = (await import(pathToFileURL(join(dir, 'server/index.mjs')).href)) as {
			z?: unknown;
			sql?: unknown;
		};
		shared.push({ zod: module.z === z, kysely: module.sql === sql });
	}
	console.log(JSON.stringify({ ids: loaded.map((ext) => ext.id), shared }));
} catch (error) {
	console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
