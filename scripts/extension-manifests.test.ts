import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../packages/sdk/src/manifest.ts';

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

describe('extension manifests', () => {
	it.each(extensions)('%s has a manifest in its package.json', (name) => {
		const pkg = JSON.parse(readFileSync(join(root, 'extensions', name, 'package.json'), 'utf8'));
		const manifest = parseManifest(pkg.famos);
		expect(manifest.id).toBe(name);
		// One version: the package's is what a package manager and a release show.
		expect(manifest.version).toBe(pkg.version);
	});

	it('checks SDK errors by their brand, never with instanceof', () => {
		// An extension installed on its own may carry another copy of the SDK, whose error
		// classes are different objects: `instanceof` would miss its errors.
		const forbidden = /instanceof\s+(FamosError|LlmError|ExternalHttpError)\b/;
		const offenders: string[] = [];
		for (const dir of ['apps', 'packages', 'extensions']) {
			for (const file of walk(join(root, dir))) {
				if (forbidden.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(root.length + 1));
			}
		}
		expect(offenders).toEqual([]);
	});
});
