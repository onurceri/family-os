import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A device's text size sets the root font size, so it reaches only sizes given in rem. A font
 * size in px stays the same at every text size: this test fails on one in the app, the shared UI
 * and the extensions' web code. A size tied to a box drawn in px (an avatar's initials) is set
 * from script and is not matched here.
 */
const ROOT = join(import.meta.dirname, '..');
const DIRS = ['apps/web/src', 'packages/ui/src', 'extensions'];
const SOURCE = /\.(svelte|ts|css)$/;
const PX_FONT = /text-\[[0-9.]+px\]|font-size:\s*[0-9.]+px/g;

function* files(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === 'dist' || name === 'test') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (SOURCE.test(name) && !name.endsWith('.test.ts')) yield path;
	}
}

describe('font sizes', () => {
	it('are in rem, so the text size setting reaches them', () => {
		const found: string[] = [];
		for (const dir of DIRS)
			for (const file of files(join(ROOT, dir))) {
				if (dir === 'extensions' && !file.includes('/src/web/')) continue;
				for (const match of readFileSync(file, 'utf8').matchAll(PX_FONT))
					found.push(`${file.slice(ROOT.length + 1)}: ${match[0]}`);
			}
		expect(found).toEqual([]);
	});
});
