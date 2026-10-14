import {
	addCatalogs,
	type Catalog,
	type Catalogs,
	createI18n,
	DEFAULT_LOCALE,
	isLocale,
	type Locale,
	negotiateLocale,
} from '@famos/i18n';
import appEn from '../messages/en.json';
import { api } from './api';

/** A language the server offers (`core.listLanguages`). */
export interface Language {
	code: string;
	name: string;
	nativeName: string;
	dir: 'ltr' | 'rtl';
	version: string;
	source: 'base' | 'bundled' | 'installed';
	coverage: number;
	overridesBundled: boolean;
}

const STORAGE_KEY = 'famos.locale';
const PACK_CACHE = 'famos.pack.';

function stored(): Locale | null {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return isLocale(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * Translations for the SPA. English is the base language and the only one bundled
 * with the build: the app's own messages here, and each extension's own `src/messages/en.json`
 * (namespace = extension id), registered with its web entry (`registerEnglish`). Every other
 * language is a language pack the server serves, with the extensions' own translations folded in;
 * it is loaded when chosen and cached. `t` reads the reactive locale, so templates re-render when
 * it changes, with no page reload. Anything a pack lacks shows in English.
 */
const i18n = createI18n({
	resources: { [DEFAULT_LOCALE]: { app: appEn } },
	locale: DEFAULT_LOCALE,
	defaultNS: 'app',
});

/**
 * Adds an extension's English texts under its id (again, after a hot reload). The app's own
 * namespace is not an extension's to replace.
 */
export function registerEnglish(namespace: string, catalog: Catalog): void {
	if (namespace === 'app') throw new Error('"app" is the namespace of the app\'s own texts');
	addCatalogs(i18n, DEFAULT_LOCALE, { [namespace]: catalog });
}

let current = $state<Locale>(DEFAULT_LOCALE);
let direction = $state<'ltr' | 'rtl'>('ltr');
let available = $state<Language[]>([
	{
		code: DEFAULT_LOCALE,
		name: 'English',
		nativeName: 'English',
		dir: 'ltr',
		version: '',
		source: 'base',
		coverage: 1,
		overridesBundled: false,
	},
]);
/** Packs already added to the i18next instance, by code, with the version that was loaded. */
const loadedVersions = new Map<string, string>();
/** Whether the list of languages came from the server (not just the English placeholder). */
let listLoaded = false;

/**
 * Translate. Typed against the English catalogs (i18next.d.ts). Reading `current` registers a
 * reactive dependency, so templates re-render on locale change. The wrapper is behaviourally
 * identical to `i18n.t`; the double cast only bridges i18next's branded TFunction type.
 */
export const t = ((...args: unknown[]): unknown => {
	void current;
	return Reflect.apply(i18n.t, i18n, args);
}) as unknown as typeof i18n.t;

/** Translate a key known only at runtime (e.g. a nav label contributed by an extension). */
export function tDynamic(key: string, options?: Record<string, unknown>): string {
	void current;
	// Pass the options to `exists` too: plural keys (`items_one`) only resolve with a count.
	return i18n.exists(key, options) ? String(Reflect.apply(i18n.t, i18n, [key, options])) : key;
}

export function getLocale(): Locale {
	return current;
}

/** Reading direction of the active language. */
export function getDirection(): 'ltr' | 'rtl' {
	return direction;
}

/** The languages the server offers; English only until the list has loaded. */
export function getLanguages(): readonly Language[] {
	return available;
}

/** Fetches the list of languages (public: needed before setup and sign-in). Keeps the old list on failure. */
export async function loadLanguages(): Promise<readonly Language[]> {
	try {
		const res = await api.GET('/api/v1/core/languages');
		// A pack that changed on the server (updated, reinstalled) is fetched again next time.
		if (res.data && res.data.length > 0) {
			available = res.data;
			listLoaded = true;
		}
	} catch {
		// offline: the list we have is good enough
	}
	return available;
}

function readCache(code: string): { version: string; catalogs: Catalogs } | null {
	try {
		const raw = localStorage.getItem(PACK_CACHE + code);
		return raw ? (JSON.parse(raw) as { version: string; catalogs: Catalogs }) : null;
	} catch {
		return null;
	}
}

function writeCache(code: string, pack: { version: string; catalogs: Catalogs }) {
	try {
		localStorage.setItem(PACK_CACHE + code, JSON.stringify(pack));
	} catch {
		// storage full or unavailable: fetch again next time
	}
}

/**
 * Makes sure a language's catalogs are in the i18next instance. The server answers with an ETag
 * per pack version, so a repeated fetch is a cheap 304; offline, the copy from last time is used.
 * Returns false when the language is unknown and could not be loaded.
 */
async function ensureLoaded(code: string, force = false): Promise<boolean> {
	if (code === DEFAULT_LOCALE) return true;
	const known = available.find((l) => l.code === code);
	if (!force && known && loadedVersions.get(code) === known.version) return true;
	try {
		const res = await api.GET('/api/v1/core/languages/{code}/catalogs', {
			params: { path: { code } },
			parseAs: 'text',
			// Revalidate with the ETag: a 304 costs almost nothing, a changed pack is fetched.
			cache: 'no-cache',
		});
		if (res.data === undefined) throw new Error('catalogs unavailable');
		const pack = JSON.parse(res.data) as { version: string; catalogs: Catalogs };
		addCatalogs(i18n, code, pack.catalogs);
		loadedVersions.set(code, pack.version);
		writeCache(code, pack);
		return true;
	} catch {
		const cached = readCache(code);
		if (!cached) return false;
		addCatalogs(i18n, code, cached.catalogs);
		loadedVersions.set(code, cached.version);
		return true;
	}
}

/**
 * Switches the UI language: loads the pack when needed, then re-renders. Region formats are not
 * touched. An unavailable language leaves the current one in place. When `remember`
 * is set the choice is kept on this device (the sign-in page, setup).
 */
export async function setLocale(
	code: Locale,
	options: { remember?: boolean; force?: boolean } = {},
): Promise<void> {
	if (!isLocale(code)) return;
	if (!(await ensureLoaded(code, options.force))) return;
	await i18n.changeLanguage(code);
	current = code;
	direction = available.find((l) => l.code === code)?.dir ?? 'ltr';
	document.documentElement.lang = code;
	document.documentElement.dir = direction;
	if (options.remember) {
		try {
			localStorage.setItem(STORAGE_KEY, code);
		} catch {
			// ignore
		}
	}
}

/**
 * The language of a person who has not signed in (or is just starting): what they chose on this
 * device, else the best match for their browser among the available packs, else English.
 */
export async function bootLanguage(stillWanted: () => boolean = () => true): Promise<void> {
	const list = await loadLanguages();
	// Someone signed in meanwhile: their own language wins.
	if (!stillWanted()) return;
	const codes = list.map((l) => l.code);
	const saved = stored();
	const code =
		// Offline (no list), a language fetched before still works from its cached copy.
		saved && (codes.includes(saved) || (!listLoaded && readCache(saved)))
			? saved
			: negotiateLocale(typeof navigator === 'undefined' ? [] : navigator.languages, codes);
	await setLocale(code);
}

/** The best language for this browser among those available (setup preselects it). */
export function preferredLanguage(): Locale {
	return negotiateLocale(
		typeof navigator === 'undefined' ? [] : navigator.languages,
		available.map((l) => l.code),
	);
}
