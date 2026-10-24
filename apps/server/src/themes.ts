import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STYLE_IDS, type StyleId, type ThemePort, type ThemeSummary } from '@famos/core';
import { FamosError, type Logger } from '@famos/sdk';
import {
	previewOf,
	renderStylesheet,
	type ThemePack,
	type ThemeTokens,
	validateThemePack,
} from '@famos/themes';
import { listThemeDirsSync, readThemeDirSync, writeThemeDir } from '@famos/themes/node';
import { createPackRegistry, type PackEntry } from './pack-registry.ts';

/** The bundled pack every other pack inherits missing tokens from, and the app's default. */
const DEFAULT_ID = 'ev-isigi';

interface Loaded extends PackEntry {
	pack: ThemePack;
	dir: string;
	css: string;
	/** Changes with the content: the stylesheet's ETag and the web app's cache key. */
	version: string;
}

export interface ThemeRegistryOptions {
	appVersion: string;
	/** Packs shipped with the app. */
	bundledDir: string | undefined;
	/** Packs an admin installed (`<data>/themes`). */
	installedDir: string;
	logger: Logger;
}

/**
 * Where the bundled packs live when `FAMOS_THEMES_DIR` is not set: next to the server bundle in
 * the image (`/app/server/main.mjs` → `/app/themes`), or at the repository root when running
 * from source or from `apps/server/dist`.
 */
export function findBundledThemes(configured: string | undefined): string | undefined {
	if (configured) return configured;
	const here = dirname(fileURLToPath(import.meta.url));
	return [resolve(here, '../themes'), resolve(here, '../../../themes')].find(
		(dir) => existsSync(dir) && listThemeDirsSync(dir).length > 0,
	);
}

const sha = (...parts: (string | Uint8Array)[]) => {
	const hash = createHash('sha256');
	for (const part of parts) hash.update(part);
	return hash.digest('hex').slice(0, 10);
};

/** What a refused pack tells the person: the first few reasons, then how many more. */
function refusal(errors: string[]): FamosError {
	const shown = errors.slice(0, 5).join('; ');
	const more = errors.length > 5 ? ` (and ${errors.length - 5} more)` : '';
	return new FamosError('bad_request', `${shown}${more}`, { problems: errors });
}

/**
 * The theme registry: bundled packs, then installed ones (an installed pack with the
 * same id replaces the bundled one). Everything is validated on the way in; a pack that fails is
 * skipped and logged, never fatal. Packs in the image are checked with contrast shortfalls as
 * warnings (Ev Işığı predates the rule); installed packs must pass.
 */
export function createThemeRegistry(options: ThemeRegistryOptions): ThemePort {
	const { appVersion, logger } = options;
	/** What a pack that leaves tokens out inherits: the bundled default's. */
	let defaults: ThemeTokens | undefined;

	const registry = createPackRegistry<Loaded>({
		noun: 'theme',
		idKey: 'id',
		logger,
		bundledDir: options.bundledDir,
		installedDir: options.installedDir,
		listFolders: listThemeDirsSync,
		// The default first: the others inherit what they leave out from it.
		orderBundled: (folders) =>
			[...folders].sort((a, b) =>
				a === DEFAULT_ID ? -1 : b === DEFAULT_ID ? 1 : a.localeCompare(b),
			),
		beforeReload() {
			defaults = undefined;
		},
		afterBundled(folder, loaded) {
			if (folder === DEFAULT_ID) defaults = loaded.get(DEFAULT_ID)?.pack.tokens;
		},
		read(root, folder) {
			const dir = join(root, folder);
			const result = validateThemePack(readThemeDirSync(dir), {
				appVersion,
				styles: STYLE_IDS,
				...(defaults && { fallback: defaults }),
			});
			if (!result.ok) throw new Error(result.errors.join('; '));
			const { pack, warnings } = result;
			if (pack.manifest.id !== folder) throw new Error('the folder is not named after the id');
			if (warnings.length > 0) {
				logger.warn({ id: folder, warnings: warnings.length }, 'theme pack has warnings');
			}
			const css = renderStylesheet(
				pack,
				(file) => `/api/v1/core/themes/${pack.manifest.id}/fonts/${encodeURIComponent(file)}`,
			);
			return {
				id: pack.manifest.id,
				entry: {
					pack,
					dir,
					css,
					version: `${pack.manifest.version}-${sha(css, ...Object.values(pack.fonts))}`,
				},
			};
		},
	});
	const summary = (entry: Loaded): ThemeSummary => ({
		id: entry.pack.manifest.id,
		name: entry.pack.manifest.name,
		version: entry.version,
		authors: entry.pack.manifest.authors ?? [],
		source: entry.source,
		overridesBundled: entry.overridesBundled,
		preview: previewOf(entry.pack.tokens),
		// Validation dropped an id that is not one of STYLE_IDS.
		style: (entry.pack.manifest.style as StyleId | undefined) ?? null,
	});

	return {
		list: () =>
			[...registry.entries.values()]
				// The default first, then by name.
				.sort((a, b) =>
					a.pack.manifest.id === DEFAULT_ID
						? -1
						: b.pack.manifest.id === DEFAULT_ID
							? 1
							: a.pack.manifest.name.localeCompare(b.pack.manifest.name),
				)
				.map(summary),
		has: (id) => registry.entries.has(id),
		stylesheet(id) {
			const entry = registry.entries.get(id);
			return entry ? { version: entry.version, css: entry.css } : null;
		},
		font(id, file) {
			const entry = registry.entries.get(id);
			const bytes =
				entry && Object.hasOwn(entry.pack.fonts, file) ? entry.pack.fonts[file] : undefined;
			if (!entry || !bytes) return null;
			// `file` is one of the pack's own validated names, so the path cannot leave its folder.
			return { stream: createReadStream(join(entry.dir, file)), size: bytes.length };
		},
		async install(input) {
			const result = validateThemePack(input, {
				appVersion,
				styles: STYLE_IDS,
				...(defaults && { fallback: defaults }),
			});
			if (!result.ok) throw refusal(result.errors);
			const { pack, warnings } = result;
			const id = pack.manifest.id;
			const raw = input as { tokens: unknown };
			const entry = await registry.install(id, (folder) =>
				writeThemeDir(folder, { manifest: pack.manifest, tokens: raw.tokens, fonts: pack.fonts }),
			);
			return { theme: summary(entry), warnings };
		},
		remove: (id) => registry.remove(id),
	};
}
