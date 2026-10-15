import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
	type ExtensionDefinition,
	type ExtensionManifest,
	parseManifest,
	SDK_VERSION,
} from '@famos/sdk';
import { z } from 'zod';
import { type BundledList, findBundledExtensions, readBundledList } from './bundled.ts';
import { guardImports, type RootKind } from './hooks.ts';
import { discoverSourceExtensions } from './source.ts';
import { PACKAGE_FILE, readWebPackage, type WebPackage } from './web.ts';

export { PACKAGE_FILE };

const LabelsSchema = z.record(z.string(), z.object({ name: z.string(), description: z.string() }));

const PackageDescriptionSchema = z.object({
	format: z.literal(1),
	manifest: z.unknown(),
	name: z.string(),
	built: z.object({ sdk: z.string() }),
	entries: z.object({ server: z.string() }),
	labels: LabelsSchema.default({}),
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

/** An extension this server has at hand: read, not yet imported. */
export interface AvailableExtension {
	id: string;
	version: string;
	/** Always installed (`extensions.json`); the others are offered. */
	always: boolean;
	manifest: ExtensionManifest;
	labels: Record<string, { name: string; description: string }>;
	/** Imports its definition, checked against what it was read as. */
	load(): Promise<ExtensionDefinition>;
	/** Its web half, if it has one (source has none: the app's dev server compiles it). */
	web(): WebPackage | undefined;
}

export interface Available {
	from: 'bundled' | 'source';
	dir: string;
	/** What the folder ships: always there, offered, and installed on a new family. */
	list: BundledList;
	extensions: AvailableExtension[];
	/** Offered packages that could not even be read, and why. */
	unreadable: { id: string; reason: string }[];
	warning?: string;
}

/**
 * The extensions this server could run. `FAMOS_DEV_EXTENSIONS` names a workspace folder whose
 * source is used as it is (development and tests; refused in production). Otherwise the packages
 * shipped next to the server bundle.
 */
export function findAvailable(env: NodeJS.ProcessEnv = process.env): Available {
	const dev = env.FAMOS_DEV_EXTENSIONS;
	if (dev) {
		if (env.NODE_ENV === 'production') {
			throw new Error(
				'FAMOS_DEV_EXTENSIONS loads unbuilt, unsigned extension source and is refused when NODE_ENV=production',
			);
		}
		return availableSource(dev);
	}
	const dir = findBundledExtensions();
	if (!dir) {
		throw new Error(
			'No extension packages next to the server bundle. Build them (pnpm build), or set ' +
				'FAMOS_DEV_EXTENSIONS=<workspace>/extensions to run from source.',
		);
	}
	const list = readBundledList(dir);
	const extensions: AvailableExtension[] = [];
	const unreadable: Available['unreadable'] = [];
	const always = new Set(list.always);
	for (const id of [...list.always, ...list.offered]) {
		try {
			extensions.push(readPackage(join(dir, id), always.has(id)));
		} catch (error) {
			// What the app always runs must be there; an offered package is only left out.
			if (always.has(id)) throw error;
			unreadable.push({ id, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { from: 'bundled', dir, list, extensions, unreadable };
}

/**
 * Every extension at hand, all loaded: generating the API documents and checking a backup need
 * them all, whatever the family installed.
 */
export async function loadExtensions(
	env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedExtensions> {
	const available = findAvailable(env);
	const first = available.unreadable[0];
	if (first) throw new Error(first.reason);
	return loadAll(available);
}

/** Loads extensions from their workspace source (development and tests). */
export async function loadSourceExtensions(root: string): Promise<LoadedExtensions> {
	return loadAll(availableSource(root));
}

async function loadAll(available: Available): Promise<LoadedExtensions> {
	const extensions: ExtensionDefinition[] = [];
	for (const ext of available.extensions) extensions.push(await ext.load());
	const web = available.extensions.map((ext) => ext.web()).filter((pkg) => pkg !== undefined);
	return {
		extensions,
		web,
		report: {
			from: available.from,
			dir: available.dir,
			loaded: summary(extensions),
			...(available.warning && { warning: available.warning }),
		},
	};
}

function availableSource(root: string): Available {
	const dir = resolve(root);
	const sources = discoverSourceExtensions(dir);
	// The workspace's own list says what is always there; without one, everything is.
	const listFile = join(dirname(dir), 'extensions.json');
	const list = existsSync(listFile)
		? readBundledList(dirname(dir))
		: { always: sources.map((s) => parseManifest(s.manifest).id), offered: [], default: [] };
	const always = new Set(list.always);
	const extensions = sources.map((source): AvailableExtension => {
		const manifest = parseManifest(source.manifest);
		const name = source.dir.split(sep).at(-1) ?? source.dir;
		return {
			id: manifest.id,
			version: manifest.version,
			always: always.has(manifest.id),
			manifest,
			labels: sourceLabels(source.dir),
			load: () => importDefinition(source.dir, source.entry, source.manifest, 'source', name),
			web: () => undefined,
		};
	});
	return {
		from: 'source',
		dir,
		list,
		extensions,
		unreadable: [],
		warning: `Running extensions from source in ${dir} (FAMOS_DEV_EXTENSIONS): unbuilt and unsigned, for development only`,
	};
}

/** The name and description of a source extension, per language, from its own catalogs. */
function sourceLabels(dir: string): AvailableExtension['labels'] {
	const from = join(dir, 'src/messages');
	const labels: AvailableExtension['labels'] = {};
	if (!existsSync(from)) return labels;
	for (const file of readdirSync(from).filter((name) => name.endsWith('.json'))) {
		const catalog = JSON.parse(readFileSync(join(from, file), 'utf8')) as Record<string, unknown>;
		const { feature_name: name, feature_description: description } = catalog;
		if (typeof name === 'string' && typeof description === 'string')
			labels[file.slice(0, -'.json'.length)] = { name, description };
	}
	return labels;
}

/**
 * Reads a built package's description and checks it was built for this platform; its code is
 * imported only by `load()`, under the import rules of a package, and must carry the manifest
 * the package describes.
 */
function readPackage(dir: string, always: boolean): AvailableExtension {
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
	const manifest = parseManifest(description.manifest);
	return {
		id: manifest.id,
		version: manifest.version,
		always,
		manifest,
		labels: description.labels,
		load: () => importDefinition(dir, join(dir, entry), description.manifest, 'package', name),
		web: () => readWebPackage(dir),
	};
}

/**
 * Loads built packages: reads each `famos-package.json`, checks it was built for this platform,
 * imports its server entry under the import rules of a package and checks that the code carries
 * the manifest the package describes.
 */
export async function loadPackages(dirs: readonly string[]): Promise<ExtensionDefinition[]> {
	const extensions: ExtensionDefinition[] = [];
	for (const dir of dirs) extensions.push(await readPackage(dir, false).load());
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

export const summary = (extensions: readonly ExtensionDefinition[]) =>
	extensions.map((ext) => ({ id: ext.id, version: ext.manifest.version }));
