import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The modules the host shares with every extension package. A package leaves these out of its
 * bundles and gets the host's own copy when it loads, so there is one zod (schemas made by a
 * package pass the host's `instanceof` checks), one Kysely, one SDK and one Svelte runtime with
 * one app context. Everything else a package uses is inlined into it.
 */
export const SHARED_SERVER: readonly string[] = ['@famos/sdk', 'zod', 'kysely', '@famos/time'];

/** A package's own `package.json` and the folder it lives in, found the way Node finds it. */
export function packageJsonOf(
	name: string,
	from: string = import.meta.dirname,
): { dir: string; pkg: PackageJson } {
	const require = createRequire(join(from, 'noop.js'));
	for (const base of require.resolve.paths(name) ?? []) {
		const file = join(base, name, 'package.json');
		if (existsSync(file)) {
			return {
				dir: realpathSync(dirname(file)),
				pkg: JSON.parse(readFileSync(file, 'utf8')) as PackageJson,
			};
		}
	}
	throw new Error(`Cannot find the package ${name} from ${from}`);
}

export interface PackageJson {
	name: string;
	version: string;
	license?: string;
	exports?: Record<string, ExportTarget>;
	famos?: unknown;
	[key: string]: unknown;
}

export type ExportTarget = string | { [condition: string]: ExportTarget };

/**
 * Svelte's subpaths that run in a browser: everything with code behind it except the compiler,
 * server rendering and the shared internals root (only `internal/client`, the version marker and
 * the flags are what compiled components import).
 */
function svelteBrowserSubpaths(exports: Record<string, ExportTarget>): string[] {
	return Object.entries(exports)
		.filter(([subpath, target]) => {
			if (subpath === './package.json' || subpath === './compiler' || subpath === './internal') {
				return false;
			}
			if (subpath.split('/').at(-1) === 'server') return false;
			return typeof target === 'string' || Object.keys(target).some((c) => c !== 'types');
		})
		.map(([subpath]) => (subpath === '.' ? 'svelte' : `svelte/${subpath.slice(2)}`));
}

/** `@famos/ui`'s subpaths, without its stylesheets (the app loads those once for everyone). */
function uiSubpaths(exports: Record<string, ExportTarget>): string[] {
	return Object.keys(exports)
		.filter((subpath) => !subpath.endsWith('.css'))
		.map((subpath) => (subpath === '.' ? '@famos/ui' : `@famos/ui/${subpath.slice(2)}`));
}

function computeSharedWeb(): string[] {
	const svelte = packageJsonOf('svelte').pkg;
	const ui = packageJsonOf('@famos/ui').pkg;
	return [
		...svelteBrowserSubpaths(svelte.exports ?? {}),
		...uiSubpaths(ui.exports ?? {}),
		'@famos/sdk',
		'zod',
		'@famos/time',
		'@famos/api-client',
	];
}

/**
 * What an extension's web bundle will leave out and take from the app, read from the exports of
 * the Svelte and `@famos/ui` the app is built with, so a new subpath of either is shared without
 * anyone keeping a list. Icons are not shared: each package keeps only the ones it uses.
 */
export const SHARED_WEB: readonly string[] = computeSharedWeb();
