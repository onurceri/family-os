import {
	addCatalogs,
	buildResources,
	type Catalogs,
	canonicalLocale,
	createI18n,
	DEFAULT_LOCALE,
	type i18n,
	isLocale,
} from '@famos/i18n';
import type { ExtensionDefinition } from '@famos/sdk';
import appEn from '../../web/src/messages/en.json' with { type: 'json' };
import type { LanguageRegistry } from './languages.ts';

/** What the loaded extensions bring to the languages: English, and their own translations. */
export interface ExtensionCatalogs {
	/** By namespace: `app` is the app's own messages, every extension's catalog sits under its id. */
	english: Catalogs;
	/** By language code, then extension id. */
	translations: Record<string, Catalogs>;
}

/**
 * Gathers the catalogs of the loaded extensions next to the app's own English. Each extension
 * brings its English and the translations it ships; a language is offered only when a pack for
 * it is installed, and its pack's strings win over an extension's own.
 */
export function catalogsOf(extensions: readonly ExtensionDefinition[]): ExtensionCatalogs {
	const english: Catalogs = { app: appEn };
	const translations: Record<string, Catalogs> = {};
	for (const ext of extensions) {
		if (!ext.messages) continue;
		for (const [code, catalog] of Object.entries(ext.messages)) {
			if (code === DEFAULT_LOCALE) english[ext.id] = catalog;
			else if (isLocale(code) && canonicalLocale(code) === code)
				translations[code] = { ...translations[code], [ext.id]: catalog };
			else
				throw new Error(`Extension "${ext.id}" names its messages "${code}", not a language code`);
		}
	}
	return { english, translations };
}

/**
 * Renders translation keys on the server (notifications, Telegram, email) from English plus the
 * registry's packs. The language is the recipient's; a missing language or string is English.
 * Follows the registry: installing or removing a pack takes effect on the next call.
 */
export function createTranslate(languages: LanguageRegistry) {
	let built = -1;
	let instance: i18n | undefined;
	const current = (): i18n => {
		if (instance && built === languages.version) return instance;
		const english = Object.entries(languages.english).map(([namespace, catalog]) => ({
			namespace,
			locale: DEFAULT_LOCALE,
			catalog,
		}));
		instance = createI18n({
			resources: buildResources(english),
			locale: DEFAULT_LOCALE,
			defaultNS: 'app',
		});
		for (const pack of languages.packs()) addCatalogs(instance, pack.manifest.code, pack.catalogs);
		built = languages.version;
		return instance;
	};
	/** `key` may carry a namespace (`inbox:notify_kind_x`); unknown keys come back as the key. */
	const translate = (locale: string, key: string, params?: Record<string, unknown>): string => {
		const i18n = current();
		const tag = canonicalLocale(locale);
		const lng = tag && languages.has(tag) ? tag : DEFAULT_LOCALE;
		return i18n.exists(key, { lng, ...params }) ? String(i18n.t(key, { lng, ...params })) : key;
	};
	return translate;
}

/**
 * The words a key lists (comma-separated) in English and every installed pack, lower-cased and
 * without repeats (`ExtensionContext.vocabulary`). Cached until the packs change.
 */
export function createVocabulary(languages: LanguageRegistry) {
	const translate = createTranslate(languages);
	let built = -1;
	const cache = new Map<string, readonly string[]>();
	return (key: string): readonly string[] => {
		if (built !== languages.version) {
			cache.clear();
			built = languages.version;
		}
		const known = cache.get(key);
		if (known) return known;
		const codes = [DEFAULT_LOCALE, ...languages.packs().map((p) => p.manifest.code)];
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
