import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An extension's web side will be built into a bundle of its own that the app loads, with
 * Svelte, `@famos/ui` and `@famos/sdk` left out of it and taken from the app (one Svelte runtime,
 * one app context). That only works while extensions reach them as packages: Svelte is a peer
 * (never a dependency of its own), and nothing reaches into their files by a relative path or
 * into Svelte's internals, which a bundler would copy in. No bundle is built yet; this keeps the
 * code ready for one.
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
});
