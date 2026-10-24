import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions, SDK_VERSION } from '@famos/sdk';
import { build, type Plugin } from 'esbuild';
import { compile } from 'svelte/compiler';
import { type ExportTarget, packageJsonOf } from './shared.ts';

/**
 * What a separately built package relies on in the host: the platform version (`SDK_VERSION`),
 * the versions of the shared libraries at the precision that can break a package (Svelte's
 * compiled output follows its minor, zod's API its major, Kysely's its minor) and the names each
 * shared module of ours exports.
 */
export interface Platform {
	sdk: string;
	svelte: string;
	zod: string;
	kysely: string;
	exports: Record<string, string[]>;
}

/** The modules of ours whose export names a package may use. */
const OWN_SHARED = ['@famos/sdk', '@famos/time', '@famos/api-client', '@famos/ui'] as const;

export async function currentPlatform(): Promise<Platform> {
	const sdk = packageJsonOf('@famos/sdk');
	const exports: Record<string, string[]> = {};
	for (const name of OWN_SHARED) Object.assign(exports, await exportNamesOf(name));
	return {
		sdk: SDK_VERSION,
		svelte: precision(packageJsonOf('svelte').pkg.version, 2),
		zod: precision(packageJsonOf('zod', sdk.dir).pkg.version, 1),
		kysely: precision(packageJsonOf('kysely', sdk.dir).pkg.version, 2),
		exports,
	};
}

function precision(version: string, parts: number): string {
	return version.split('.').slice(0, parts).join('.');
}

function entryFile(target: ExportTarget): string | undefined {
	if (typeof target === 'string') return target;
	for (const condition of ['svelte', 'import', 'default']) {
		const inner = target[condition];
		if (inner !== undefined) return entryFile(inner);
	}
	return undefined;
}

/**
 * Only the entry's own code is read: every other package is left out, and a component the entry
 * re-exports stays unread (its name is in the re-export). An entry that is itself a component is
 * compiled to find what it exports.
 */
const leaveOutComponents: Plugin = {
	name: 'leave-out-components',
	setup(build) {
		build.onResolve({ filter: /\.svelte$/ }, (args) =>
			args.kind === 'entry-point' ? undefined : { path: args.path, external: true },
		);
		build.onLoad({ filter: /\.svelte$/ }, async (args) => {
			const source = await readFile(args.path, 'utf8');
			return { contents: compile(source, { filename: args.path }).js.code, loader: 'js' };
		});
	},
};

async function exportNamesOf(name: string): Promise<Record<string, string[]>> {
	const { dir, pkg } = packageJsonOf(name);
	const subpaths = Object.entries(pkg.exports ?? {}).filter(
		([subpath]) => !subpath.endsWith('.css') && subpath !== './package.json',
	);
	const entries = new Map<string, string>();
	for (const [subpath, target] of subpaths) {
		const file = entryFile(target);
		if (file === undefined) continue;
		entries.set(subpath === '.' ? name : `${name}/${subpath.slice(2)}`, join(dir, file));
	}
	const result = await build({
		entryPoints: [...entries.values()],
		absWorkingDir: dir,
		bundle: true,
		write: false,
		outdir: join(dir, '.platform'),
		format: 'esm',
		platform: 'neutral',
		packages: 'external',
		loader: { '.css': 'empty' },
		metafile: true,
		logLevel: 'silent',
		plugins: [leaveOutComponents],
	});
	const byEntry = new Map<string, string[]>();
	for (const output of Object.values(result.metafile.outputs)) {
		if (output.entryPoint !== undefined) {
			byEntry.set(join(dir, output.entryPoint), [...output.exports].sort());
		}
	}
	const names: Record<string, string[]> = {};
	for (const [specifier, file] of entries) names[specifier] = byEntry.get(file) ?? [];
	return names;
}

export type PlatformCheck =
	| { ok: true }
	| { ok: false; reason: 'bump' | 'update'; message: string; required: 'minor' | 'patch' };

const UPDATE = 'pnpm --filter @famos/pack platform:update';

/**
 * Compares the committed platform with the current one. A change that can break a package built
 * before it (another Svelte minor, zod major or Kysely minor, or a removed module or export
 * name) needs a new minor of `SDK_VERSION`; names only added need at least a new patch, so a
 * package built against them is never loaded by a host that lacks them.
 */
export function checkPlatform(committed: Platform, current: Platform): PlatformCheck {
	if (JSON.stringify(committed) === JSON.stringify(current)) return { ok: true };
	const { sdk: _committedSdk, ...was } = committed;
	const { sdk: _currentSdk, ...now } = current;
	const changes = describeChanges(was, now);
	const breaking = changes.some((change) => !change.startsWith('+'));
	const required = breaking ? 'minor' : 'patch';
	const bumped =
		changes.length === 0 ||
		(breaking ? minorAbove(current.sdk, committed.sdk) : versionAbove(current.sdk, committed.sdk));
	if (bumped) {
		return {
			ok: false,
			reason: 'update',
			required,
			message: `The platform snapshot (packages/pack/platform.json) is out of date. Run \`${UPDATE}\` and commit it.`,
		};
	}
	return {
		ok: false,
		reason: 'bump',
		required,
		message: [
			'What the host shares with extension packages changed:',
			...changes.map((change) => `  ${change}`),
			breaking
				? `This can break packages built before it: raise the minor of SDK_VERSION (packages/sdk/src/manifest.ts, now ${current.sdk}) and every extension manifest's "sdk" caret to match.`
				: `Packages built against it need a host that has it: raise at least the patch of SDK_VERSION (packages/sdk/src/manifest.ts, now ${current.sdk}).`,
			`Then run \`${UPDATE}\` and commit packages/pack/platform.json.`,
		].join('\n'),
	};
}

function describeChanges(was: Omit<Platform, 'sdk'>, now: Omit<Platform, 'sdk'>): string[] {
	const changes: string[] = [];
	for (const key of ['svelte', 'zod', 'kysely'] as const) {
		if (was[key] !== now[key]) changes.push(`~${key} ${was[key]} → ${now[key]}`);
	}
	const modules = new Set([...Object.keys(was.exports), ...Object.keys(now.exports)]);
	for (const module of [...modules].sort()) {
		const before = was.exports[module];
		const after = now.exports[module];
		if (before === undefined) changes.push(`+${module}`);
		else if (after === undefined) changes.push(`-${module}`);
		else {
			for (const name of before) if (!after.includes(name)) changes.push(`-${module} ${name}`);
			for (const name of after) if (!before.includes(name)) changes.push(`+${module} ${name}`);
		}
	}
	return changes;
}

function minorAbove(version: string, than: string): boolean {
	const minor = (v: string) => v.split('.').slice(0, 2).join('.');
	return compareVersions(minor(version), minor(than)) > 0;
}

function versionAbove(version: string, than: string): boolean {
	return compareVersions(version, than) > 0;
}
