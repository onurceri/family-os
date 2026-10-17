import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A file input is either the control people use, or a hidden helper that a visible button
 * opens. A helper that is only visually hidden (`sr-only`) is still in the accessibility tree,
 * so a screen reader meets a second, unexplained "Choose file" next to the real button. Such a
 * helper is taken out of it (`aria-hidden="true"` and `tabindex="-1"`); one that is the control
 * itself (inside its label) has a name (`aria-label`) and stays focusable.
 */
const root = join(import.meta.dirname, '..');
const dirs = [
	'apps/web/src',
	...readdirSync(join(root, 'packages')).map((p) => `packages/${p}/src`),
	...readdirSync(join(root, 'extensions')).map((e) => `extensions/${e}/src`),
];

function* walk(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name !== 'node_modules') yield* walk(path);
		} else if (name.endsWith('.svelte')) yield path;
	}
}

/** The `<input …>` tags of a file whose type is `file`. */
const fileInputs = (text: string) =>
	[...text.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((tag) => /\btype="file"/.test(tag));

describe('file inputs', () => {
	it('are either a named control or hidden from assistive technology', () => {
		const wrong: string[] = [];
		for (const dir of dirs) {
			for (const file of walk(join(root, dir))) {
				for (const tag of fileInputs(readFileSync(file, 'utf8'))) {
					if (!/class="[^"]*\bsr-only\b/.test(tag)) continue;
					const hidden = /aria-hidden="true"/.test(tag) && /tabindex="-1"/.test(tag);
					const control = /aria-label=/.test(tag) && !/tabindex="-1"/.test(tag);
					if (!hidden && !control) wrong.push(relative(root, file));
				}
			}
		}
		expect(wrong).toEqual([]);
	});

	it('finds the inputs it checks', () => {
		const board = readFileSync(join(root, 'extensions/board/src/web/Composer.svelte'), 'utf8');
		expect(fileInputs(board)).toHaveLength(1);
	});
});
