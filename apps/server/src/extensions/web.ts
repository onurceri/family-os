import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { PACKAGE_FILE } from '@famos/pack/format';
import { z } from 'zod';

/** Where the browser loads package files from: `/extensions/<id>/<digest>/<path>`. */
export const EXTENSION_ASSETS = '/extensions';

const WebDescriptionSchema = z.object({
	manifest: z.object({ id: z.string(), version: z.string() }),
	entries: z.object({ web: z.string().optional(), css: z.string().optional() }),
	files: z.record(z.string(), z.string()),
});

/**
 * A package's digest: the first 32 hex digits of the SHA-256 of its `famos-package.json`, which
 * lists every file's hash, so it names exactly one build. Its web files are served under it and a
 * stored copy lives in a folder of that name.
 */
export const digestOf = (description: Uint8Array): string =>
	createHash('sha256').update(description).digest('hex').slice(0, 32);

/** The browser half of a built package: what the app imports and what the server may hand out. */
export interface WebPackage {
	id: string;
	version: string;
	/** The package folder on disk. */
	dir: string;
	/** Of `famos-package.json`, which lists every file's hash: a new build is a new address. */
	digest: string;
	/** The web entry module and the stylesheet, relative to the folder. */
	entry: string;
	css?: string;
	/** Every file under `web/` the package lists, relative to the folder. */
	files: string[];
}

/**
 * The web half of the package in `dir`, or undefined when it has none. Only files the package
 * lists are ever served, and the entries must be among them.
 */
export function readWebPackage(dir: string): WebPackage | undefined {
	const bytes = readFileSync(`${dir}/${PACKAGE_FILE}`);
	const description = WebDescriptionSchema.parse(JSON.parse(bytes.toString('utf8')));
	const { web, css } = description.entries;
	if (!web) return undefined;
	const files = Object.keys(description.files).filter((path) => path.startsWith('web/'));
	const name = `${description.manifest.id} (${dir})`;
	for (const path of [web, css]) {
		if (path === undefined) continue;
		if (!files.includes(path) || isAbsolute(path) || normalize(path) !== path) {
			throw new Error(`The extension package ${name} has a web entry it does not list: ${path}`);
		}
	}
	return {
		id: description.manifest.id,
		version: description.manifest.version,
		dir,
		digest: digestOf(bytes),
		entry: web,
		...(css && { css }),
		files,
	};
}

/** What the app is told about the extensions this server runs. */
export interface LoadedWeb {
	/** Changes whenever an extension, its version or its build changes: the app compares it. */
	fingerprint: string;
	extensions: { id: string; version: string }[];
	/** The web packages, in the order the app registers them. */
	packages: WebPackage[];
}

/**
 * Puts the running extensions and their web packages together. An extension loaded from source
 * (development) has no package: the app's dev server compiles its web code itself.
 */
export function describeLoaded(
	extensions: readonly { id: string; version: string }[],
	packages: readonly WebPackage[],
): LoadedWeb {
	const listed = extensions.map(({ id, version }) => ({ id, version }));
	const ids = new Set(listed.map((e) => e.id));
	// By id, so the app registers them in the same order whatever order they were found in.
	const web = packages.filter((p) => ids.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));
	const digests = new Map(web.map((p) => [p.id, p.digest]));
	const fingerprint = createHash('sha256')
		.update(
			JSON.stringify(
				listed
					.map((e) => [e.id, e.version, digests.get(e.id) ?? ''])
					.sort(([a], [b]) => String(a).localeCompare(String(b))),
			),
		)
		.digest('hex')
		.slice(0, 16);
	return { fingerprint, extensions: listed, packages: web };
}

/** A package file's address in the browser. */
export const assetUrl = (pkg: WebPackage, path: string): string =>
	`${EXTENSION_ASSETS}/${pkg.id}/${pkg.digest}/${path}`;
