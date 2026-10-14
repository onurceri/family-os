import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguagePort, LanguageSummary } from '@famos/core';
import {
	type Catalogs,
	coverage,
	DEFAULT_LOCALE,
	type LanguagePack,
	packFingerprint,
	textDirection,
	validatePack,
	withOwnTranslations,
} from '@famos/i18n';
import { listPackDirsSync, readPackDirSync, writePackDir } from '@famos/i18n/node';
import { FamosError, type Logger } from '@famos/sdk';

/** More installed packs than anyone needs; keeps the data directory and the language list sane. */
const MAX_INSTALLED = 40;

interface Loaded {
	pack: LanguagePack;
	source: 'bundled' | 'installed';
	overridesBundled: boolean;
	coverage: number;
	/** Changes with the content: the version clients cache catalogs by. */
	version: string;
}

export interface LanguageRegistry extends LanguagePort {
	/** Increases whenever packs are installed, removed or reloaded: consumers rebuild their caches. */
	readonly version: number;
	/** The English catalogs by namespace (the app's and every loaded extension's). */
	readonly english: Catalogs;
	/** The loaded packs (not English), each with the extensions' own translations folded in. */
	packs(): readonly LanguagePack[];
}

export interface LanguageRegistryOptions {
	/** English catalogs by namespace: the base every pack is checked against. */
	english: Catalogs;
	/**
	 * The translations the loaded extensions ship, by language code then namespace. They fill in
	 * under a pack of the same language.
	 */
	translations?: Readonly<Record<string, Catalogs>>;
	appVersion: string;
	/** Packs shipped with the app. */
	bundledDir: string | undefined;
	/** Packs an admin installed (`<data>/languages`). */
	installedDir: string;
	logger: Logger;
}

/**
 * Where the bundled packs live when `FAMOS_LANGUAGES_DIR` is not set: next to the server bundle
 * in the image (`/app/server/main.mjs` → `/app/languages`), or at the repository root when
 * running from source or from `apps/server/dist`.
 */
export function findBundledLanguages(configured: string | undefined): string | undefined {
	if (configured) return configured;
	const here = dirname(fileURLToPath(import.meta.url));
	return [resolve(here, '../languages'), resolve(here, '../../../languages')].find(
		(dir) => existsSync(dir) && listPackDirsSync(dir).length > 0,
	);
}

/**
 * The language registry: bundled packs, then installed ones (an installed pack with
 * the same code replaces the bundled one). Everything is validated against English on the way
 * in; a pack that fails is skipped and logged, never fatal. A pack shows over the translations
 * the extensions ship of its language; what neither has is English.
 */
export function createLanguageRegistry(options: LanguageRegistryOptions): LanguageRegistry {
	const { english, appVersion, logger } = options;
	const translations = options.translations ?? {};
	let loaded = new Map<string, Loaded>();
	let version = 0;

	function readDir(root: string, source: Loaded['source'], into: Map<string, Loaded>) {
		for (const folder of listPackDirsSync(root)) {
			try {
				const result = validatePack(readPackDirSync(join(root, folder)), english, { appVersion });
				if (!result.ok) throw new Error(result.error);
				if (result.pack.manifest.code !== folder)
					throw new Error('the folder is not named after the code');
				const shown = withOwnTranslations(result.pack, translations[folder] ?? {}, english);
				const { pack } = shown;
				const problems = [...result.problems, ...shown.problems];
				if (problems.length > 0) {
					logger.warn(
						{ code: folder, problems: problems.length },
						'language pack has unusable strings',
					);
				}
				into.set(pack.manifest.code, {
					pack,
					source,
					overridesBundled:
						source === 'installed' && into.get(pack.manifest.code)?.source === 'bundled',
					coverage: coverage(english, pack).ratio,
					version: `${pack.manifest.version}-${packFingerprint(pack)}`,
				});
			} catch (error) {
				logger.warn(
					{ code: folder, reason: error instanceof Error ? error.message : 'unreadable' },
					'language pack skipped',
				);
			}
		}
	}

	function reload() {
		const next = new Map<string, Loaded>();
		if (options.bundledDir) readDir(options.bundledDir, 'bundled', next);
		readDir(options.installedDir, 'installed', next);
		loaded = next;
		version++;
	}
	reload();

	const summary = (code: string, entry: Loaded): LanguageSummary => ({
		code,
		name: entry.pack.manifest.name,
		nativeName: entry.pack.manifest.nativeName,
		dir: entry.pack.manifest.dir ?? textDirection(code),
		version: entry.version,
		source: entry.source,
		coverage: entry.coverage,
		overridesBundled: entry.overridesBundled,
	});

	return {
		get version() {
			return version;
		},
		english,
		packs: () => [...loaded.values()].map((l) => l.pack),
		list() {
			const base: LanguageSummary = {
				code: DEFAULT_LOCALE,
				name: 'English',
				nativeName: 'English',
				dir: 'ltr',
				version: appVersion,
				source: 'base',
				coverage: 1,
				overridesBundled: false,
			};
			return [
				base,
				...[...loaded.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([c, e]) => summary(c, e)),
			];
		},
		has: (code) => code === DEFAULT_LOCALE || loaded.has(code),
		catalogs(code) {
			const entry = loaded.get(code);
			if (!entry) return null;
			return {
				code,
				version: entry.version,
				dir: entry.pack.manifest.dir ?? textDirection(code),
				catalogs: entry.pack.catalogs,
			};
		},
		async install(input) {
			const result = validatePack(input, english, { appVersion });
			if (!result.ok) throw new FamosError('bad_request', result.error);
			const { pack, problems } = result;
			const code = pack.manifest.code;
			const installedCount = [...loaded.values()].filter((l) => l.source === 'installed').length;
			if (installedCount >= MAX_INSTALLED && loaded.get(code)?.source !== 'installed')
				throw new FamosError('conflict', 'Too many language packs are installed');
			if (Object.keys(pack.catalogs).length === 0)
				throw new FamosError('bad_request', 'The pack has no usable strings');
			await writePackDir(join(options.installedDir, code), pack);
			reload();
			const entry = loaded.get(code);
			if (!entry)
				throw new FamosError('unavailable', 'The pack could not be loaded after installing');
			return { language: summary(code, entry), problems };
		},
		async remove(code) {
			if (loaded.get(code)?.source !== 'installed')
				throw new FamosError('not_found', 'That pack is not installed');
			// The code is a pack's own (validated) code, so the folder name cannot leave the directory.
			await rm(join(options.installedDir, code), { recursive: true, force: true });
			reload();
		},
	};
}
