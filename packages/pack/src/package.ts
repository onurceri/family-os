import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseManifest, SDK_VERSION } from '@famos/sdk';
import { build, type Metafile } from 'esbuild';
import { type PackageJson, packageJsonOf, SHARED_SERVER } from './shared.ts';
import { buildWeb, WEB_ENTRY, WEB_STYLES } from './web.ts';

/** The version of the package format, so a host can refuse one it does not understand. */
export const PACKAGE_FORMAT = 1;

/** The file that describes a built package; every other file is listed in it with its hash. */
export const PACKAGE_FILE = 'famos-package.json';

export interface PackageDescription {
	format: typeof PACKAGE_FORMAT;
	/** The `famos` field of the extension's package.json, exactly as written (checked when built). */
	manifest: Record<string, unknown>;
	name: string;
	license: string;
	/** The platform the package was built against: the SDK version and Svelte's version. */
	built: { sdk: string; svelte: string };
	/** Entry files, relative to the package folder: the server module, the web module and its styles. */
	entries: { server: string; web?: string; css?: string };
	/** The feature's name and description in each language it ships, for an install screen. */
	labels: Record<string, { name: string; description: string }>;
	/** Every other file of the package, relative to its folder, with its SHA-256 (hex). */
	files: Record<string, string>;
}

export interface BuildOptions {
	/** Where to write the package. Defaults to the extension's own `dist/`. */
	outDir?: string;
}

export interface BuildResult {
	outDir: string;
	description: PackageDescription;
	/** The imports the server bundle leaves to the host (bare specifiers and `node:` modules). */
	serverImports: string[];
	/** The modules the web bundle takes from the app (none when the extension has no web entry). */
	webImports: string[];
}

const SERVER_ENTRY = 'server/index.mjs';

/**
 * Builds an extension into a package folder: its server code as one ES module that imports only
 * the modules the host shares and Node's own, its web code as ES modules that import only what
 * the app shares (with a stylesheet of the utilities it uses), its message catalogs, its API
 * description, a license and `famos-package.json`, which lists every file with its hash.
 */
export async function buildExtension(
	dir: string,
	options: BuildOptions = {},
): Promise<BuildResult> {
	const root = resolve(dir);
	const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson;
	parseManifest(pkg.famos);
	const manifest = pkg.famos as Record<string, unknown>;
	const outDir = resolve(options.outDir ?? join(root, 'dist'));
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });

	const serverImports = await buildServer(root, outDir);
	const hasWeb = existsSync(join(root, 'src/web/index.ts'));
	const webImports = hasWeb ? await buildWeb(root, outDir) : [];
	const labels = await copyMessages(root, outDir);
	await copyFile(join(root, 'openapi.json'), join(outDir, 'openapi.json'));
	await copyFile(findLicense(root), join(outDir, 'LICENSE'));

	const description: PackageDescription = {
		format: PACKAGE_FORMAT,
		manifest,
		name: pkg.name,
		license: pkg.license ?? 'UNLICENSED',
		built: { sdk: SDK_VERSION, svelte: packageJsonOf('svelte').pkg.version },
		entries: { server: SERVER_ENTRY, ...(hasWeb && { web: WEB_ENTRY, css: WEB_STYLES }) },
		labels,
		files: await hashFiles(outDir),
	};
	await writeFile(join(outDir, PACKAGE_FILE), `${JSON.stringify(description, null, '\t')}\n`);
	return { outDir, description, serverImports, webImports };
}

async function buildServer(root: string, outDir: string): Promise<string[]> {
	const result = await build({
		absWorkingDir: root,
		entryPoints: [join(root, 'src/server/index.ts')],
		outfile: join(outDir, SERVER_ENTRY),
		bundle: true,
		platform: 'node',
		target: 'node24',
		format: 'esm',
		sourcemap: true,
		external: [...SHARED_SERVER, 'node:*'],
		metafile: true,
		logLevel: 'silent',
	});
	const imports = leftToHost(result.metafile);
	const refused = imports.filter((path) => !isShared(path));
	if (refused.length > 0) {
		throw new Error(
			`The server bundle of ${root} imports ${refused.join(', ')}, which the host does not share. ` +
				`Shared: ${SHARED_SERVER.join(', ')} and node: modules; everything else must be inlined.`,
		);
	}
	return imports;
}

/**
 * What the bundle still imports at run time. Externals are listed exactly as written, so
 * `zod/mini` or a builtin without its `node:` prefix shows up here and is refused.
 */
export function leftToHost(metafile: Metafile): string[] {
	const imports = new Set<string>();
	for (const output of Object.values(metafile.outputs)) {
		for (const entry of output.imports) if (entry.external) imports.add(entry.path);
	}
	return [...imports].sort();
}

function isShared(path: string): boolean {
	return SHARED_SERVER.includes(path) || path.startsWith('node:');
}

async function copyMessages(
	root: string,
	outDir: string,
): Promise<Record<string, { name: string; description: string }>> {
	const from = join(root, 'src/messages');
	const labels: Record<string, { name: string; description: string }> = {};
	await mkdir(join(outDir, 'messages'), { recursive: true });
	for (const file of (await readdir(from)).filter((name) => name.endsWith('.json')).sort()) {
		const text = await readFile(join(from, file), 'utf8');
		await writeFile(join(outDir, 'messages', file), text);
		const catalog = JSON.parse(text) as Record<string, unknown>;
		const name = catalog.feature_name;
		const description = catalog.feature_description;
		if (typeof name === 'string' && typeof description === 'string') {
			labels[file.slice(0, -'.json'.length)] = { name, description };
		}
	}
	if (!labels.en) {
		throw new Error(`${from}/en.json needs feature_name and feature_description`);
	}
	return labels;
}

/** The extension's own LICENSE, or the nearest one above it (the repository's). */
function findLicense(root: string): string {
	for (let dir = root; ; dir = dirname(dir)) {
		const file = join(dir, 'LICENSE');
		if (existsSync(file)) return file;
		if (dirname(dir) === dir) throw new Error(`No LICENSE file in ${root} or above it`);
	}
}

/** Every file under `dir` with its SHA-256, by its path relative to `dir` (always with `/`). */
export async function hashFiles(dir: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	const paths = entries
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
		.filter((path) => path !== PACKAGE_FILE)
		.sort();
	for (const path of paths) {
		files[path] = createHash('sha256')
			.update(await readFile(join(dir, path)))
			.digest('hex');
	}
	return files;
}
