import { existsSync } from 'node:fs';
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
import { createPackRegistry, type PackEntry } from './pack-registry.ts';

interface Loaded extends PackEntry {
	pack: LanguagePack;
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

	const registry = createPackRegistry<Loaded>({
		noun: 'language',
		idKey: 'code',
		logger,
		bundledDir: options.bundledDir,
		installedDir: options.installedDir,
		listFolders: listPackDirsSync,
		read(root, folder) {
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
			return {
				id: pack.manifest.code,
				entry: {
					pack,
					coverage: coverage(english, pack).ratio,
					version: `${pack.manifest.version}-${packFingerprint(pack)}`,
				},
			};
		},
	});

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
			return registry.version;
		},
		english,
		packs: () => [...registry.entries.values()].map((l) => l.pack),
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
				...[...registry.entries]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([c, e]) => summary(c, e)),
			];
		},
		has: (code) => code === DEFAULT_LOCALE || registry.entries.has(code),
		catalogs(code) {
			const entry = registry.entries.get(code);
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
			const entry = await registry.install(code, async (folder) => {
				if (Object.keys(pack.catalogs).length === 0)
					throw new FamosError('bad_request', 'The pack has no usable strings');
				await writePackDir(folder, pack);
			});
			return { language: summary(code, entry), problems };
		},
		remove: (code) => registry.remove(code),
	};
}
