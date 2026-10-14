import i18next, { type i18n } from 'i18next';
import {
	type Catalog,
	type Catalogs,
	canonicalLocale,
	DEFAULT_LOCALE,
	isLocale,
	type Locale,
	type Resources,
} from './catalog.ts';

/**
 * Shared i18n setup for the web app and the server. Built on i18next.
 *
 * English is the base language and the only one the app's code knows. Its catalogs live in code:
 *   apps/web/src/messages/en.json                → namespace "app"
 *   extensions/<id>/src/messages/en.json         → namespace "<id>", registered by the extension
 * Every other language is a language pack (data, see `pack.ts`): `languages/<code>/`, laid over
 * the translations extensions ship (`extensions/<id>/src/messages/<code>.json`). Missing
 * strings show in English (`fallbackLng`). Interpolation uses i18next syntax: "Hello, {{name}}".
 */
/**
 * Picks the best available language from preferences such as `navigator.languages`: an exact
 * match first (`pt-BR`), then the same language without its region (`pt-BR` → `pt`), then any
 * available regional variant of the language (`pt` → `pt-BR`). English when nothing fits.
 */
export function negotiateLocale(
	preferences: readonly string[],
	available: readonly string[] = [DEFAULT_LOCALE],
): Locale {
	const byLower = new Map(available.map((code) => [code.toLowerCase(), code]));
	for (const preference of preferences) {
		const tag = canonicalLocale(preference);
		if (!tag) continue;
		const parts = tag.toLowerCase().split('-');
		for (let n = parts.length; n >= 1; n--) {
			const hit = byLower.get(parts.slice(0, n).join('-'));
			if (hit) return hit;
		}
		const base = parts[0] ?? '';
		const variant = available.find((code) => code.toLowerCase().split('-')[0] === base);
		if (variant) return variant;
	}
	return DEFAULT_LOCALE;
}

/** The language's name in English, as "Answer in Turkish" prompts and lists need it. */
export function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** Reading direction of a language, from `Intl.Locale` text info (left to right when unknown). */
export function textDirection(code: string): 'ltr' | 'rtl' {
	try {
		const locale = new Intl.Locale(code) as Intl.Locale & {
			getTextInfo?: () => { direction: string };
			textInfo?: { direction: string };
		};
		const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction;
		return direction === 'rtl' ? 'rtl' : 'ltr';
	} catch {
		return 'ltr';
	}
}

export interface CatalogEntry {
	namespace: string;
	locale: Locale;
	catalog: Catalog;
}

/** Groups catalog files into i18next resources; an invalid language code is rejected loudly. */
export function buildResources(entries: readonly CatalogEntry[]): Resources {
	const resources: Resources = { [DEFAULT_LOCALE]: {} };
	for (const { namespace, locale, catalog } of entries) {
		if (!isLocale(locale))
			throw new Error(`Invalid language code "${locale}" in namespace "${namespace}"`);
		const catalogs = resources[locale] ?? {};
		resources[locale] = catalogs;
		if (catalogs[namespace]) throw new Error(`Duplicate catalog ${namespace}/${locale}`);
		catalogs[namespace] = catalog;
	}
	return resources;
}

export interface CreateI18nOptions {
	resources: Resources;
	locale: Locale;
	defaultNS: string;
}

/** Creates an isolated, synchronously initialised i18next instance. English is the fallback. */
export function createI18n(options: CreateI18nOptions): i18n {
	const instance = i18next.createInstance();
	void instance.init({
		resources: options.resources,
		lng: options.locale,
		fallbackLng: DEFAULT_LOCALE,
		ns: Object.keys(options.resources[DEFAULT_LOCALE] ?? {}),
		defaultNS: options.defaultNS,
		// Svelte escapes interpolated text itself; HTML output elsewhere must escape explicitly.
		interpolation: { escapeValue: false },
		returnNull: false,
		initAsync: false,
	});
	return instance;
}

/** Adds (or replaces) one language's catalogs on a running instance. */
export function addCatalogs(instance: i18n, locale: Locale, catalogs: Catalogs): void {
	for (const [namespace, catalog] of Object.entries(catalogs)) {
		instance.addResourceBundle(locale, namespace, catalog, true, true);
	}
}

export type { i18n, TFunction } from 'i18next';
export * from './catalog.ts';
export * from './pack.ts';
