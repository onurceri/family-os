import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	addCatalogs,
	buildResources,
	createI18n,
	DEFAULT_LOCALE,
	validatePack,
	withOwnTranslations,
} from '@famos/i18n';
import { listPackDirsSync, readCheckoutCatalogs, readPackDirSync } from '@famos/i18n/node';

/**
 * A translator for tests that need real texts: English from every catalog in the repository plus
 * the bundled language packs in `languages/` over the extensions' own translations, with English
 * as fallback like the server's. `createTestKernel` renders a notification's key by default; pass this as
 * `translate` when a test reads the words.
 */
export function repoTranslate(): (
	locale: string,
	key: string,
	params?: Record<string, unknown>,
) => string {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
	const { english, translations } = readCheckoutCatalogs(root);
	const i18n = createI18n({
		resources: buildResources(
			Object.entries(english).map(([namespace, catalog]) => ({
				namespace,
				locale: DEFAULT_LOCALE,
				catalog,
			})),
		),
		locale: DEFAULT_LOCALE,
		defaultNS: 'app',
	});
	const known = new Set([DEFAULT_LOCALE]);
	for (const code of listPackDirsSync(join(root, 'languages'))) {
		const result = validatePack(readPackDirSync(join(root, 'languages', code)), english);
		if (!result.ok) throw new Error(`${code}: ${result.error}`);
		const { pack } = withOwnTranslations(result.pack, translations[code] ?? {}, english);
		addCatalogs(i18n, pack.manifest.code, pack.catalogs);
		known.add(result.pack.manifest.code);
	}
	return (locale, key, params) => {
		const lng = known.has(locale) ? locale : DEFAULT_LOCALE;
		return i18n.exists(key, { lng, ...params }) ? String(i18n.t(key, { lng, ...params })) : key;
	};
}

/**
 * The words a key lists in English and every bundled pack, like the server's
 * (`ExtensionContext.vocabulary`). `createTestKernel` uses it unless a test passes its own.
 */
export function repoVocabulary(): (key: string) => readonly string[] {
	const translate = repoTranslate();
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
	const codes = [DEFAULT_LOCALE, ...listPackDirsSync(join(root, 'languages'))];
	const cache = new Map<string, readonly string[]>();
	return (key) => {
		const known = cache.get(key);
		if (known) return known;
		const words = new Set<string>();
		for (const code of codes) {
			const text = translate(code, key);
			if (text === key) continue;
			for (const word of text.split(',')) {
				const clean = word.trim().toLocaleLowerCase(code);
				if (clean) words.add(clean);
			}
		}
		const list = [...words];
		cache.set(key, list);
		return list;
	};
}
