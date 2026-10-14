/**
 * Generates each extension's API types from the OpenAPI document `main.ts openapi --extensions`
 * wrote into its folder: `<dir>/<id>/openapi.json` becomes `<dir>/<id>/src/web/api.gen.d.ts`.
 * Kept out of main.ts so the production bundle never carries openapi-typescript.
 *
 * Usage: tsx scripts/api-types.ts <extensions dir>
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: tsx scripts/api-types.ts <extensions dir>');

let written = 0;
for (const entry of await readdir(dir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const source = join(dir, entry.name, 'openapi.json');
	const doc = await readFile(source, 'utf8').catch(() => null);
	if (doc === null) continue;
	const text = `${COMMENT_HEADER}${astToString(await openapiTS(JSON.parse(doc), { silent: true }))}`;
	const out = join(dir, entry.name, 'src', 'web', 'api.gen.d.ts');
	// Unchanged files are left alone: type checks may be reading them while this runs.
	const current = await readFile(out, 'utf8').catch(() => null);
	if (current !== text) await writeFile(out, text);
	written++;
}
console.log(`API types generated for ${written} extension(s)`);
