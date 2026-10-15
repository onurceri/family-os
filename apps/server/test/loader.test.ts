import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDK_VERSION } from '@famos/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { loadExtensions } from '../src/extensions/load.ts';

const root = mkdtempSync(join(tmpdir(), 'famos-packages-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Writes a built package the way `@famos/pack` lays one out, with the given server code. */
function writePackage(
	name: string,
	code: string,
	options: { manifest?: Record<string, unknown>; built?: string } = {},
): string {
	const dir = join(root, name);
	mkdirSync(join(dir, 'server'), { recursive: true });
	writeFileSync(join(dir, 'server/index.mjs'), code);
	const manifest = options.manifest ?? { id: name, version: '0.1.0', sdk: `^${SDK_VERSION}` };
	writeFileSync(
		join(dir, 'famos-package.json'),
		JSON.stringify({
			format: 1,
			manifest,
			name: `@test/${name}`,
			license: 'AGPL-3.0-or-later',
			built: { sdk: options.built ?? SDK_VERSION, svelte: '5.0.0' },
			entries: { server: 'server/index.mjs' },
			labels: { en: { name, description: name } },
			files: {},
		}),
	);
	return dir;
}

const definition = (id: string, version = '0.1.0') => `
import { sql } from 'kysely';
import { z } from 'zod';
import { defineExtension } from '@famos/sdk';
export { sql, z };
export default defineExtension({ manifest: { id: '${id}', version: '${version}', sdk: '^${SDK_VERSION}' } });
`;

/** Loads packages in a plain Node process, so Node's resolver and the host's hook do the work. */
function load(...dirs: string[]): { ids?: string[]; shared?: unknown[]; error?: string } {
	const script = join(import.meta.dirname, 'support/load-packages.ts');
	const run = spawnSync(process.execPath, [script, ...dirs], { encoding: 'utf8' });
	// Zero warnings: neither the import hook nor running the host's TypeScript may print any.
	expect(run.stderr).toBe('');
	return JSON.parse(run.stdout);
}

describe('extension packages', () => {
	it("get the host's own zod and Kysely", () => {
		const result = load(writePackage('probe', definition('probe')));
		expect(result).toEqual({ ids: ['probe'], shared: [{ zod: true, kysely: true }] });
	});

	it('may not import a module the host does not share', () => {
		const dir = writePackage('stray', `import ICAL from 'ical.js';\n${definition('stray')}`);
		expect(load(dir).error).toMatch(
			/@test\/stray .* imports ical\.js, which the host does not share/,
		);
	});

	it('may not import a file outside their folder', () => {
		writePackage('other', definition('other'));
		const dir = writePackage(
			'reach',
			`import '../../other/server/index.mjs';\n${definition('reach')}`,
		);
		expect(load(dir).error).toMatch(
			/imports \.\.\/\.\.\/other\/server\/index\.mjs, which lies outside/,
		);
	});

	it('are refused when the code carries another manifest than the package describes', () => {
		const dir = writePackage('drift', definition('drift', '0.2.0'));
		expect(load(dir).error).toMatch(/drift .* carries a manifest that differs/);
	});

	it('are refused when built for another platform', () => {
		const [major, minor] = SDK_VERSION.split('.').map(Number) as [number, number];
		const dir = writePackage('ahead', definition('ahead'), { built: `${major}.${minor + 1}.0` });
		expect(load(dir).error).toMatch(/was built for platform/);
	});
});

describe('extension source', () => {
	it('is refused in production', async () => {
		await expect(
			loadExtensions({ FAMOS_DEV_EXTENSIONS: root, NODE_ENV: 'production' }),
		).rejects.toThrow(/refused when NODE_ENV=production/);
	});
});
