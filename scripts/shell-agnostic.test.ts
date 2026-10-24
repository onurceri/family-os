import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The web shell (`apps/web/src`) never names an extension: what it shows of one comes from the
 * extension's own `./web` entry (pages, navigation, slots, timelines, Today's facets and blocks),
 * so an extension can be installed or left out without changing the shell. This scans the shell
 * for the ways it could still name one: an extension's API (`/api/v1/<id>`), one of its
 * capabilities (`can('<id>.…')`) or events (`onEvent('<id>.…')`), a page an extension serves
 * (`'/calendar'`, `'/settings/photos-weather'`) and a route folder named after one.
 */
const root = join(import.meta.dirname, '..');
const shell = join(root, 'apps/web/src');
const extensions = readdirSync(join(root, 'extensions')).filter((name) =>
	statSync(join(root, 'extensions', name)).isDirectory(),
);

function* walk(dir: string, match: RegExp): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path, match);
		else if (match.test(name)) yield path;
	}
}

/** The paths extensions serve or link their pages by (`path: '/kitchen'`, `SETTINGS_PATH = '…'`). */
function extensionPaths(): Set<string> {
	const paths = new Set<string>();
	const declared = /\b(?:path|page|href|[A-Z_]*PATH)\s*[:=]\s*'(\/[^':]+)'/g;
	for (const ext of extensions) {
		const web = join(root, 'extensions', ext, 'src/web');
		let files: string[];
		try {
			files = [...walk(web, /\.ts$/)];
		} catch {
			continue;
		}
		for (const file of files) {
			for (const m of readFileSync(file, 'utf8').matchAll(declared)) paths.add(m[1] as string);
		}
	}
	return paths;
}

/**
 * Known exceptions, each with its reason. The service worker is built apart from the app, so it
 * cannot read what extensions contribute (their offline reads reach it as a message from the app):
 * the PWA's share target (declared in the static web manifest) hands what the phone shares to the share page, `/share`.
 */
const EXCEPTIONS = new Set([
	'apps/web/src/service-worker/index.ts: a page of an extension (/share)',
]);

/** Where a shell file names an extension, one line per finding. */
function findings(file: string, text: string, paths: ReadonlySet<string>): string[] {
	const found: string[] = [];
	const ids = extensions.join('|');
	const rules: [RegExp, string][] = [
		[new RegExp(`/api/v1/(${ids})\\b`, 'g'), 'its API'],
		// The same path as a regular expression, its slashes escaped (the service worker's allow-list).
		[new RegExp(`\\\\/api\\\\/v1\\\\/(${ids})\\b`, 'g'), 'its API (escaped)'],
		[new RegExp(`\\bcan\\(\\s*['"\`](${ids})\\.`, 'g'), 'one of its capabilities'],
		[new RegExp(`\\bonEvent\\(\\s*['"\`](${ids})\\.`, 'g'), 'its events'],
	];
	for (const [re, what] of rules) {
		for (const m of text.matchAll(re)) found.push(`${file}: ${what} (${m[0]})`);
	}
	for (const m of text.matchAll(/['"`](\/[a-z][^'"`\s?#]*)['"`]/g)) {
		const path = m[1] as string;
		if (paths.has(path)) found.push(`${file}: a page of an extension (${path})`);
	}
	return found;
}

describe('the web shell never names an extension', () => {
	// The app imports extensions at run time from the packages the server runs; it builds none in.
	it('depends on no extension', () => {
		const pkg = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8'));
		const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
		expect(deps.filter((name) => name.startsWith('@famos/ext-'))).toEqual([]);
	});

	// Only the dev server compiles extension source (for hot reload), from one place.
	it('reaches extension source only from the development loader', () => {
		const found = [...walk(shell, /\.(ts|svelte)$/)]
			.filter((file) => !file.endsWith('.test.ts'))
			.filter((file) => /['"`][./]*\/extensions\/\*/.test(readFileSync(file, 'utf8')))
			.map((file) => file.slice(root.length + 1));
		expect(found).toEqual(['apps/web/src/lib/extensions.ts']);
	});

	it('has no route of an extension', () => {
		const routes = readdirSync(join(shell, 'routes'));
		expect(routes.filter((name) => extensions.includes(name))).toEqual([]);
	});

	it('reaches no API, capability, event or page of an extension', () => {
		const paths = extensionPaths();
		// The scan knows what extensions declare: a few pages it must find.
		expect(paths.has('/calendar')).toBe(true);
		const found = [...walk(shell, /\.(ts|svelte)$/)]
			.filter((file) => !file.endsWith('.test.ts'))
			.flatMap((file) => findings(file.slice(root.length + 1), readFileSync(file, 'utf8'), paths));
		expect(found.filter((f) => !EXCEPTIONS.has(f))).toEqual([]);
	});

	it('finds an extension named in the ways it looks for', () => {
		const paths = new Set(['/garden']);
		const text = `api.GET('/api/v1/calendar/occurrences'); app.can('chores.view');
			app.onEvent('ambient.', f); goto('/garden'); /^\\/api\\/v1\\/lists\\/tasks$/`;
		expect(findings('x.ts', text, paths)).toHaveLength(5);
	});
});
