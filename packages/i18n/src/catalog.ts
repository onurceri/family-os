/** Catalog types and helpers shared by the i18n modules. */
export const DEFAULT_LOCALE = 'en';
/** A language code: a BCP 47 tag such as `tr` or `pt-BR`. Which ones exist is the registry's business. */
export type Locale = string;

export type Catalog = { [key: string]: string | Catalog };
/** One language's catalogs, by namespace. */
export type Catalogs = Record<string, Catalog>;
/** Catalogs of several languages: language code → namespace → catalog. */
export type Resources = Record<Locale, Catalogs>;

/** The canonical form of a language tag, or null when it is not a valid BCP 47 tag. */
export function canonicalLocale(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > 35) return null;
	try {
		return Intl.getCanonicalLocales(value)[0] ?? null;
	} catch {
		return null;
	}
}

/** Whether the value is a syntactically valid language code (not whether a pack exists for it). */
export const isLocale = (value: unknown): value is Locale => canonicalLocale(value) !== null;

export function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of Object.entries(catalog)) {
		if (key === '$schema') continue;
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === 'string') out.set(path, value);
		else if (value && typeof value === 'object')
			for (const [k, v] of flatten(value, path)) out.set(k, v);
	}
	return out;
}

/**
 * The inverse of `flatten`: dotted paths back to nested objects (i18next's key separator). A path
 * with a `__proto__` part is no key of a catalog and is left out, so a pack can never reach the
 * prototype of the objects built here (or of every object).
 */
export function unflatten(flat: ReadonlyMap<string, string>): Catalog {
	const root: Catalog = {};
	for (const [path, text] of flat) {
		const parts = path.split('.');
		if (parts.includes('__proto__')) continue;
		let node = root;
		for (const part of parts.slice(0, -1)) {
			const next = Object.hasOwn(node, part) ? node[part] : undefined;
			if (typeof next === 'object') node = next;
			else {
				const created: Catalog = {};
				node[part] = created;
				node = created;
			}
		}
		node[parts.at(-1) ?? path] = text;
	}
	return root;
}
