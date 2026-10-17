import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Browsers do not allow `:has()` inside `:has()`. Inside a forgiving `:is()` the nested part is
 * silently dropped, elsewhere the whole rule is: either way a layout rule quietly stops working
 * (a display's clock vanished this way). Write the inner condition as a relative selector of the
 * outer `:has()` instead: `:has(> .head :is(.time, .status))`, not `:has(> .head:has(.time))`.
 */
const root = join(import.meta.dirname, '..');

function* walk(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name === 'dist' || name === 'build') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (name.endsWith('.svelte') || name.endsWith('.css')) yield path;
	}
}

/** The CSS of a file: a component's `<style>`, or the whole stylesheet. */
const cssOf = (path: string, text: string) =>
	path.endsWith('.css') ? text : (/<style[^>]*>([\s\S]*)<\/style>/.exec(text)?.[1] ?? '');

/** Each `:has(...)` argument that holds another `:has(`. */
function nestedHas(css: string): string[] {
	const found: string[] = [];
	for (let at = css.indexOf(':has('); at >= 0; at = css.indexOf(':has(', at + 1)) {
		let depth = 0;
		let end = at + 4;
		for (; end < css.length; end++) {
			if (css[end] === '(') depth++;
			else if (css[end] === ')' && --depth === 0) break;
		}
		const inner = css.slice(at + 5, end);
		if (inner.includes(':has(')) found.push(inner.replace(/\s+/g, ' ').trim());
	}
	return found;
}

describe('stylesheets', () => {
	it('finds a nested :has()', () => {
		expect(nestedHas('.a:not(:has(> .b:has(.c))) {}')).toHaveLength(1);
		expect(nestedHas('.a:not(:has(> .b :is(.c, .d), > .e)) {}')).toEqual([]);
	});

	it('never nests :has() inside :has()', () => {
		const offenders = ['apps/web/src', 'packages/ui/src', 'extensions']
			.flatMap((dir) => [...walk(join(root, dir))])
			.flatMap((path) =>
				nestedHas(cssOf(path, readFileSync(path, 'utf8'))).map(
					(inner) => `${path.slice(root.length + 1)}: :has(${inner})`,
				),
			);
		expect(offenders).toEqual([]);
	});
});
