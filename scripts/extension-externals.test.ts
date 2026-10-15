import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARED_MODULES } from '../apps/server/src/extensions/hooks.ts';
import { SHARED_MODULES_FILE as SERVED_MAP } from '../apps/server/src/http/static.ts';
import { SHARED_SERVER, SHARED_WEB } from '../packages/pack/src/shared.ts';
import { LAYER_ORDER } from '../packages/pack/src/styles.ts';
import { SHARED_MODULES_FILE } from '../packages/pack/src/vite.ts';

/**
 * Extensions are built into packages of their own (`@famos/pack`). The server bundle leaves
 * `SHARED_SERVER` out, and the build refuses anything else it would leave to the host. The web
 * bundle leaves `SHARED_WEB` out and takes Svelte, `@famos/ui` and `@famos/sdk` from the app
 * (one Svelte runtime, one app context). That only works while extensions reach them as
 * packages: Svelte is a peer (never a dependency of its own), nothing reaches into their files by
 * a relative path or into Svelte's internals, which a bundler would copy in, and every subpath of
 * Svelte or `@famos/ui` an extension imports is one the app shares.
 */
const root = join(import.meta.dirname, '..');
const extensions = readdirSync(join(root, 'extensions')).filter((name) =>
	statSync(join(root, 'extensions', name)).isDirectory(),
);

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (/\.(ts|svelte)$/.test(name)) yield path;
	}
}

/** Imports that would put a copy of what the app shares into an extension's bundle. */
const INLINED = [
	/from\s+['"](?:\.\.\/)+(?:packages|node_modules)\//,
	/from\s+['"][^'"]*\/packages\/(?:ui|sdk)\//,
	/from\s+['"]svelte\/internal/,
];

describe('extension bundles leave out what the app shares', () => {
	it.each(extensions)('%s takes Svelte from the app', (name) => {
		const pkg = JSON.parse(readFileSync(join(root, 'extensions', name, 'package.json'), 'utf8'));
		expect(pkg.dependencies?.svelte).toBeUndefined();
		expect(pkg.peerDependencies?.svelte).toBeDefined();
	});

	it('reaches Svelte, @famos/ui and @famos/sdk only as packages', () => {
		const offenders = extensions.flatMap((name) =>
			[...walk(join(root, 'extensions', name, 'src'))]
				.filter((file) => INLINED.some((re) => re.test(readFileSync(file, 'utf8'))))
				.map((file) => file.slice(root.length + 1)),
		);
		expect(offenders).toEqual([]);
	});

	it('imports only the subpaths of Svelte and @famos/ui that the app shares', () => {
		const specifier = /(?:from|import)\s+['"]((?:svelte|@famos\/ui)(?:\/[^'"]*)?)['"]/g;
		const unshared = extensions.flatMap((name) =>
			[...walk(join(root, 'extensions', name, 'src', 'web'))].flatMap((file) =>
				[...readFileSync(file, 'utf8').matchAll(specifier)]
					.map((match) => match[1] ?? '')
					.filter((path) => !SHARED_WEB.includes(path))
					.map((path) => `${file.slice(root.length + 1)}: ${path}`),
			),
		);
		expect(unshared).toEqual([]);
	});

	// A package built to leave a module to the host fails to load when the host does not hand it
	// over, and one the host hands over but packages inline gives two instances.
	it('leaves to the host exactly what the server hands to packages', () => {
		expect([...SHARED_SERVER].sort()).toEqual([...SHARED_MODULES].sort());
	});

	// The app's build writes which chunk provides each shared module; the server reads that file
	// to write the import map.
	it('maps the shared modules from the file the app build writes', () => {
		expect(SERVED_MAP).toBe(SHARED_MODULES_FILE);
	});

	// A package's stylesheet and the app's declare the same layer order, whichever loads first.
	it('orders the cascade layers in the app as in every package', () => {
		const css = readFileSync(join(root, 'apps/web/src/app.css'), 'utf8');
		expect(css).toContain(LAYER_ORDER);
	});
});
