import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A comment says why the code is the way it is in its own words. "See section 5.6" stops being
 * true the day the document is renumbered, and tells a reader nothing on its own, so the source
 * never cites a design document's sections, a decision record or a plan's phase.
 */
const root = join(import.meta.dirname, '..');
const dirs = [
	'apps/server/src',
	'apps/web/src',
	...readdirSync(join(root, 'packages')).flatMap((p) => [
		`packages/${p}/src`,
		`packages/${p}/test`,
	]),
	...readdirSync(join(root, 'extensions')).flatMap((e) => [
		`extensions/${e}/src`,
		`extensions/${e}/test`,
	]),
];

// Whitespace may be a line break inside a comment, so a citation split over two lines is found too.
const CITATION = /design[-\s]+system\s+v\d|\bsections?\s+\d+\.\d+|\bADR[-\s]?\d|\bphase\s+\d\b/gi;

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
			if (name !== 'generated' && name !== 'node_modules') yield* walk(path);
		} else if (/\.(ts|svelte|css)$/.test(name)) yield path;
	}
}

describe('comments explain themselves', () => {
	it('never cite a document section, a decision record or a phase', () => {
		const found: string[] = [];
		for (const dir of dirs) {
			for (const file of walk(join(root, dir))) {
				const text = readFileSync(file, 'utf8');
				for (const match of text.matchAll(CITATION)) {
					const line = text.slice(0, match.index).split('\n').length;
					found.push(`${relative(root, file)}:${line}: ${match[0]}`);
				}
			}
		}
		expect(found).toEqual([]);
	});
});
