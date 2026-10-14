import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Catalog, type Catalogs, DEFAULT_LOCALE } from './catalog.ts';

/**
 * File access for language packs (server and translator tools; never the browser).
 * A pack on disk is a folder `<code>/` with `manifest.json` and one `<namespace>.json` each.
 */

/** A pack as found on disk or sent by a client, before validation. */
export interface RawPack {
	manifest: unknown;
	catalogs: Record<string, unknown>;
}

/** Reads a pack folder. Throws when the folder or its manifest is unreadable. */
export async function readPackDir(dir: string): Promise<RawPack> {
	const manifest: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
	const catalogs: Record<string, unknown> = {};
	for (const file of await readdir(dir)) {
		if (!file.endsWith('.json') || file === 'manifest.json') continue;
		catalogs[file.slice(0, -'.json'.length)] = JSON.parse(await readFile(join(dir, file), 'utf8'));
	}
	return { manifest, catalogs };
}

/** Like `readPackDir`, for starting up (the server loads its packs before it serves). */
export function readPackDirSync(dir: string): RawPack {
	const manifest: unknown = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
	const catalogs: Record<string, unknown> = {};
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.json') || file === 'manifest.json') continue;
		catalogs[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
	}
	return { manifest, catalogs };
}

/** The pack folders (one per language code) inside a directory; none when it does not exist. */
export function listPackDirsSync(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

/** Writes a pack folder, replacing what was there (files of removed namespaces go too). */
export async function writePackDir(dir: string, pack: RawPack): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(pack.manifest, null, '\t')}\n`);
	for (const [namespace, catalog] of Object.entries(pack.catalogs)) {
		// Namespaces come from validated packs (English namespaces), never from a path a client chose.
		if (!/^[a-z][a-z0-9_-]*$/i.test(namespace)) throw new Error(`Invalid namespace "${namespace}"`);
		await writeFile(join(dir, `${namespace}.json`), `${JSON.stringify(catalog, null, '\t')}\n`);
	}
}

/** The catalogs of a checkout: English by namespace, and the translations extensions ship. */
export interface CheckoutCatalogs {
	/** The app's `app` and every extension's own namespace. */
	english: Catalogs;
	/** By language code, then namespace: each extension's `src/messages/<code>.json`. */
	translations: Record<string, Catalogs>;
}

/**
 * Reads the catalogs of a checkout (tools and tests; the server takes them from the extensions
 * it loads). An extension's catalogs are `extensions/<id>/src/messages/<code>.json`.
 */
export function readCheckoutCatalogs(repoRoot: string): CheckoutCatalogs {
	const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Catalog;
	const english: Catalogs = { app: read(join(repoRoot, 'apps/web/src/messages/en.json')) };
	const translations: Record<string, Catalogs> = {};
	for (const entry of readdirSync(join(repoRoot, 'extensions'), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(repoRoot, 'extensions', entry.name, 'src/messages');
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith('.json'));
		} catch {
			continue; // an extension without messages
		}
		for (const file of files) {
			const code = file.slice(0, -'.json'.length);
			const catalog = read(join(dir, file));
			if (code === DEFAULT_LOCALE) english[entry.name] = catalog;
			else translations[code] = { ...translations[code], [entry.name]: catalog };
		}
	}
	return { english, translations };
}
