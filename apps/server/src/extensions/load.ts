import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { type ExtensionDefinition, parseManifest, SDK_VERSION } from '@famos/sdk';
import { z } from 'zod';
import { findBundledExtensions, readBundledList } from './bundled.ts';
import { guardImports, type RootKind } from './hooks.ts';
import { discoverSourceExtensions } from './source.ts';
import { PACKAGE_FILE, readWebPackage, type WebPackage } from './web.ts';

export { PACKAGE_FILE };

const PackageDescriptionSchema = z.object({
	format: z.literal(1),
	manifest: z.unknown(),
	name: z.string(),
	built: z.object({ sdk: z.string() }),
	entries: z.object({ server: z.string() }),
});

export interface LoadedExtensions {
	extensions: ExtensionDefinition[];
	/** The browser halves of the loaded packages (none when running from source). */
	web: WebPackage[];
	report: LoadReport;
}

export interface LoadReport {
	/** `bundled`: the packages shipped with the app. `source`: workspace source (development). */
	from: 'bundled' | 'source';
	dir: string;
	loaded: { id: string; version: string }[];
	/** Said loudly in the log at start. */
	warning?: string;
}

/**
 * The extensions this server runs. `FAMOS_DEV_EXTENSIONS` names a workspace folder whose source
 * is loaded as it is (development and tests; refused in production). Otherwise every package
 * shipped next to the server bundle is loaded.
 */
export async function loadExtensions(
	env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedExtensions> {
	const dev = env.FAMOS_DEV_EXTENSIONS;
	if (dev) {
		if (env.NODE_ENV === 'production') {
			throw new Error(
				'FAMOS_DEV_EXTENSIONS loads unbuilt, unsigned extension source and is refused when NODE_ENV=production',
			);
		}
		return loadSourceExtensions(dev);
	}
	const dir = findBundledExtensions();
	if (!dir) {
		throw new Error(
			'No extension packages next to the server bundle. Build them (pnpm build), or set ' +
				'FAMOS_DEV_EXTENSIONS=<workspace>/extensions to run from source.',
		);
	}
	const list = readBundledList(dir);
	const dirs = [...list.always, ...list.offered].map((id) => join(dir, id));
	const extensions = await loadPackages(dirs);
	const web = dirs.map(readWebPackage).filter((pkg) => pkg !== undefined);
	return { extensions, web, report: { from: 'bundled', dir, loaded: summary(extensions) } };
}

/** Loads extensions from their workspace source (development and tests). */
export async function loadSourceExtensions(root: string): Promise<LoadedExtensions> {
	const dir = resolve(root);
	const sources = discoverSourceExtensions(dir);
	const extensions: ExtensionDefinition[] = [];
	for (const source of sources) {
		const name = source.dir.split(sep).at(-1) ?? source.dir;
		extensions.push(
			await importDefinition(source.dir, source.entry, source.manifest, 'source', name),
		);
	}
	return {
		extensions,
		web: [],
		report: {
			from: 'source',
			dir,
			loaded: summary(extensions),
			warning: `Running extensions from source in ${dir} (FAMOS_DEV_EXTENSIONS): unbuilt and unsigned, for development only`,
		},
	};
}

/**
 * Loads built packages: reads each `famos-package.json`, checks it was built for this platform,
 * imports its server entry under the import rules of a package and checks that the code carries
 * the manifest the package describes.
 */
export async function loadPackages(dirs: readonly string[]): Promise<ExtensionDefinition[]> {
	const extensions: ExtensionDefinition[] = [];
	for (const dir of dirs) {
		const file = join(dir, PACKAGE_FILE);
		if (!existsSync(file))
			throw new Error(`No extension package at ${dir} (${PACKAGE_FILE} is missing)`);
		const parsed = PackageDescriptionSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
		if (!parsed.success) throw new Error(`${file} is not a package description this host reads`);
		const description = parsed.data;
		const name = `${description.name} (${dir})`;
		if (!builtForThisHost(description.built.sdk)) {
			throw new Error(
				`The extension package ${name} was built for platform ${description.built.sdk}; this host is ${SDK_VERSION}`,
			);
		}
		const entry = normalize(description.entries.server);
		if (isAbsolute(entry) || entry.startsWith('..')) {
			throw new Error(`The extension package ${name} has its server entry outside its folder`);
		}
		extensions.push(
			await importDefinition(dir, join(dir, entry), description.manifest, 'package', name),
		);
	}
	return extensions;
}

async function importDefinition(
	dir: string,
	entry: string,
	rawManifest: unknown,
	kind: RootKind,
	name: string,
): Promise<ExtensionDefinition> {
	const manifest = parseManifest(rawManifest);
	guardImports(dir, kind, name);
	const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
	const definition = module.default;
	if (!isDefinition(definition)) {
		throw new Error(`The extension ${name} does not export an extension definition by default`);
	}
	if (!isDeepStrictEqual(definition.manifest, manifest)) {
		throw new Error(
			`The extension ${name} carries a manifest that differs from the one it is described by (${manifest.id})`,
		);
	}
	return definition;
}

function isDefinition(value: unknown): value is ExtensionDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		'manifest' in value &&
		typeof value.manifest === 'object'
	);
}

/**
 * A package works on the platform it was built for and on later patches of it: within one minor
 * version only names are added, so what it was built against is all there.
 */
function builtForThisHost(built: string): boolean {
	const parts = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
	const b = parts(built);
	const h = parts(SDK_VERSION);
	if (!b || !h) return false;
	return b[0] === h[0] && b[1] === h[1] && (b[2] ?? 0) <= (h[2] ?? 0);
}

const summary = (extensions: readonly ExtensionDefinition[]) =>
	extensions.map((ext) => ({ id: ext.id, version: ext.manifest.version }));
