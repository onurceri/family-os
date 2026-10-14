import { z } from 'zod';
import {
	type Catalog,
	type Catalogs,
	canonicalLocale,
	DEFAULT_LOCALE,
	flatten,
	unflatten,
} from './catalog.ts';

/**
 * Language packs: a language is data, not code. A pack is a manifest plus one catalog
 * per namespace, validated against the English catalogs before anything uses it. Strings are text
 * only: they are rendered as text everywhere and never as HTML.
 */

/** Largest pack, as JSON. */
export const MAX_PACK_BYTES = 2 * 1024 * 1024;
/** Longest single string. */
export const MAX_STRING_BYTES = 4 * 1024;

const bytes = (text: string) => new TextEncoder().encode(text).length;

export const PackManifestSchema = z.object({
	/** BCP 47 language code, e.g. `tr`, `pt-BR`. `en` is the base language and cannot be a pack. */
	code: z
		.string()
		.refine((v) => canonicalLocale(v) !== null, 'Not a valid BCP 47 language code')
		.transform((v) => canonicalLocale(v) as string)
		.refine((v) => v !== DEFAULT_LOCALE, 'English is the base language, not a pack'),
	/** The language's name in English ("Turkish"). */
	name: z.string().trim().min(1).max(80),
	/** The language's name in itself ("Türkçe"). */
	nativeName: z.string().trim().min(1).max(80),
	/** The pack's own version (semver), shown in Settings and used for cache validation. */
	version: z
		.string()
		.regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'Expected a version like 1.0.0'),
	/** The app versions the pack was made for, as a semver range such as `>=0.1.0`. */
	famos: z.string().trim().min(1).max(100),
	/** Reading direction; derived from the language when left out. */
	dir: z.enum(['ltr', 'rtl']).optional(),
	authors: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** What the pack holds that the app could not use. Nothing here stops a pack from loading. */
export interface PackProblem {
	namespace: string;
	key: string;
	kind: 'unknown_key' | 'not_text' | 'placeholders' | 'too_long';
}

export interface LanguagePack {
	manifest: PackManifest;
	/** Only the strings that passed validation, nested as i18next expects. */
	catalogs: Catalogs;
}

export type PackValidation =
	| { ok: true; pack: LanguagePack; problems: PackProblem[] }
	| { ok: false; error: string };

const PLURAL_SUFFIX = /^(.*)_(zero|one|two|few|many|other)$/;

const placeholders = (text: string): Set<string> =>
	new Set([...text.matchAll(/{{\s*([\w.]+)\s*(?:,[^}]*)?}}/g)].map((m) => m[1] as string));

const sameSet = (a: Set<string>, b: Set<string>) =>
	a.size === b.size && [...a].every((x) => b.has(x));

/** The plural forms a language uses (CLDR through `Intl.PluralRules`), e.g. one/other or one/few/many/other. */
export function pluralCategories(code: string): string[] {
	try {
		return new Intl.PluralRules(code).resolvedOptions().pluralCategories as string[];
	} catch {
		return ['one', 'other'];
	}
}

/** English keys grouped into units: a plural group (`items_one`, `items_other`) is one unit. */
interface EnglishIndex {
	flat: Map<string, string>;
	/** Plural base (`items`) → the English texts of its forms. */
	plurals: Map<string, string[]>;
}

function indexEnglish(english: Catalog): EnglishIndex {
	const flat = flatten(english);
	const plurals = new Map<string, string[]>();
	for (const [key, text] of flat) {
		const m = PLURAL_SUFFIX.exec(key);
		if (!m) continue;
		const base = m[1] as string;
		plurals.set(base, [...(plurals.get(base) ?? []), text]);
	}
	// English plurals have both forms; a lone `x_other` ("Other" as a category name) is a plain key.
	for (const base of [...plurals.keys()]) {
		if (!flat.has(`${base}_one`) || !flat.has(`${base}_other`)) plurals.delete(base);
	}
	return { flat, plurals };
}

/** The placeholders a translation of `key` may use, or null when English has no such key. */
function allowedPlaceholders(
	key: string,
	english: EnglishIndex,
	categories: readonly string[],
): { allowed: Set<string>; exact: boolean } | null {
	const text = english.flat.get(key);
	const m = PLURAL_SUFFIX.exec(key);
	const forms = m ? english.plurals.get(m[1] as string) : undefined;
	if (forms && (text !== undefined || categories.includes(m?.[2] as string))) {
		// A plural form may leave {{count}} out ("one item"), so it may use any placeholder of the group.
		return { allowed: new Set(forms.flatMap((f) => [...placeholders(f)])), exact: false };
	}
	if (text !== undefined) return { allowed: placeholders(text), exact: true };
	return null;
}

/**
 * Checks one namespace of a translation against English. Returns the strings that may be used
 * and the problems of those that may not.
 */
export function checkNamespace(
	namespace: string,
	english: Catalog,
	translated: unknown,
	code: string,
): { catalog: Catalog; problems: PackProblem[] } {
	const problems: PackProblem[] = [];
	const index = indexEnglish(english);
	const categories = pluralCategories(code);
	const kept = new Map<string, string>();
	if (typeof translated !== 'object' || translated === null || Array.isArray(translated)) {
		return { catalog: {}, problems: [{ namespace, key: '', kind: 'not_text' }] };
	}
	// Walk the raw value so non-string leaves are reported rather than silently skipped.
	const walk = (node: unknown, prefix: string) => {
		for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
			if (name === '$schema') continue;
			const key = prefix ? `${prefix}.${name}` : name;
			if (typeof value === 'object' && value !== null && !Array.isArray(value)) walk(value, key);
			else if (typeof value !== 'string') problems.push({ namespace, key, kind: 'not_text' });
			else {
				const rule = allowedPlaceholders(key, index, categories);
				if (!rule) problems.push({ namespace, key, kind: 'unknown_key' });
				else if (bytes(value) > MAX_STRING_BYTES)
					problems.push({ namespace, key, kind: 'too_long' });
				else {
					const used = placeholders(value);
					const fine = rule.exact
						? sameSet(used, rule.allowed)
						: [...used].every((p) => rule.allowed.has(p));
					if (fine) kept.set(key, value);
					else problems.push({ namespace, key, kind: 'placeholders' });
				}
			}
		}
	};
	walk(translated, '');
	return { catalog: unflatten(kept), problems };
}

/**
 * Validates a pack from untrusted input (`{ manifest, catalogs }`) against the installed English
 * (the app's and every installed extension's catalog). A bad manifest or an oversized pack is
 * refused; bad strings are dropped and reported, the rest of the pack loads. A pack may lack a
 * namespace (that only lowers its coverage) and may carry one of an extension that is not
 * installed (it is left out, since there is nothing to check it against).
 */
export function validatePack(
	input: unknown,
	english: Catalogs,
	options: { appVersion?: string } = {},
): PackValidation {
	if (typeof input !== 'object' || input === null)
		return { ok: false, error: 'Not a language pack' };
	const { manifest: rawManifest, catalogs: rawCatalogs } = input as {
		manifest?: unknown;
		catalogs?: unknown;
	};
	let size: number;
	try {
		size = bytes(JSON.stringify(input));
	} catch {
		return { ok: false, error: 'Not a language pack' };
	}
	if (size > MAX_PACK_BYTES) return { ok: false, error: 'The pack is larger than 2 MB' };
	const parsed = PackManifestSchema.safeParse(rawManifest);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			ok: false,
			error: `Invalid manifest${issue ? ` (${issue.path.join('.') || 'manifest'}: ${issue.message})` : ''}`,
		};
	}
	const manifest = parsed.data;
	if (options.appVersion && !satisfiesRange(options.appVersion, manifest.famos)) {
		return {
			ok: false,
			error: `The pack is made for FamilyOS ${manifest.famos}, this is ${options.appVersion}`,
		};
	}
	if (typeof rawCatalogs !== 'object' || rawCatalogs === null || Array.isArray(rawCatalogs)) {
		return { ok: false, error: 'The pack has no catalogs' };
	}
	const catalogs: Catalogs = {};
	const problems: PackProblem[] = [];
	for (const [namespace, translated] of Object.entries(rawCatalogs)) {
		const base = english[namespace];
		if (!base) continue;
		const checked = checkNamespace(namespace, base, translated, manifest.code);
		problems.push(...checked.problems);
		if (flatten(checked.catalog).size > 0) catalogs[namespace] = checked.catalog;
	}
	return { ok: true, pack: { manifest, catalogs }, problems };
}

/**
 * What a language shows: the pack's strings over the translations the extensions ship of the
 * same language (`own`, by namespace), so a pack only needs what it changes or adds. English fills
 * in the rest when the strings are used. The extensions' strings are checked like a pack's; those
 * that fail are left out and reported.
 */
export function withOwnTranslations(
	pack: LanguagePack,
	own: Catalogs,
	english: Catalogs,
): { pack: LanguagePack; problems: PackProblem[] } {
	const catalogs: Catalogs = { ...pack.catalogs };
	const problems: PackProblem[] = [];
	for (const [namespace, translated] of Object.entries(own)) {
		const base = english[namespace];
		if (!base) continue;
		const checked = checkNamespace(namespace, base, translated, pack.manifest.code);
		problems.push(...checked.problems);
		const merged = new Map([
			...flatten(checked.catalog),
			...flatten(pack.catalogs[namespace] ?? {}),
		]);
		if (merged.size > 0) catalogs[namespace] = unflatten(merged);
	}
	return { pack: { manifest: pack.manifest, catalogs }, problems };
}

export interface Coverage {
	/** Share of English strings the pack translates, 0 to 1. */
	ratio: number;
	translated: number;
	total: number;
	/** Keys of English the pack lacks (plural groups by their base), per namespace. */
	missing: { namespace: string; key: string }[];
}

/** How much of English a pack translates. A plural group counts once, when all its forms are there. */
export function coverage(english: Catalogs, pack: LanguagePack): Coverage {
	return catalogCoverage(english, pack.catalogs, pack.manifest.code);
}

/** How much of English the catalogs of language `code` translate (see `coverage`). */
export function catalogCoverage(english: Catalogs, catalogs: Catalogs, code: string): Coverage {
	const categories = pluralCategories(code);
	let total = 0;
	let translated = 0;
	const missing: Coverage['missing'] = [];
	for (const [namespace, base] of Object.entries(english)) {
		const index = indexEnglish(base);
		const have = flatten(catalogs[namespace] ?? {});
		const seen = new Set<string>();
		for (const key of index.flat.keys()) {
			const m = PLURAL_SUFFIX.exec(key);
			const base = m && index.plurals.has(m[1] as string) ? (m[1] as string) : null;
			const unit = base ?? key;
			if (seen.has(unit)) continue;
			seen.add(unit);
			total++;
			const present = base ? categories.every((c) => have.has(`${base}_${c}`)) : have.has(key);
			if (present) translated++;
			else missing.push({ namespace, key: unit });
		}
	}
	return { ratio: total === 0 ? 1 : translated / total, translated, total, missing };
}

/** A pack's bytes as served (for the version/ETag): changes whenever its content changes. */
export function packFingerprint(pack: LanguagePack): string {
	const text = JSON.stringify([pack.manifest, pack.catalogs]);
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = (Math.imul(h2, 31) + c) >>> 0;
	}
	return `${h1.toString(36)}${h2.toString(36)}`;
}

// -- Version ranges -----------------------------------------------------------------------------

const parseVersion = (v: string): [number, number, number] | null => {
	const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
};

const compare = (a: [number, number, number], b: [number, number, number]) =>
	a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether `version` satisfies a small semver range: space-separated comparators (`>=1.2.0`,
 * `<2`, `=1.0.0`), `^1.2.0`, `~1.2.0`, `1.x` or `*`. Anything else does not match.
 */
export function satisfiesRange(version: string, range: string): boolean {
	const v = parseVersion(version);
	if (!v) return false;
	const terms = range.trim().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return false;
	return terms.every((term) => {
		if (term === '*' || term === 'x') return true;
		const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(term);
		if (!m) return false;
		const op = m[1] ?? '=';
		const wild = /^(\d+)\.(?:x|\*)$/.exec(m[2] as string);
		if (wild) return v[0] === Number(wild[1]);
		const target = parseVersion(m[2] as string);
		if (!target) return false;
		const c = compare(v, target);
		switch (op) {
			case '>=':
				return c >= 0;
			case '<=':
				return c <= 0;
			case '>':
				return c > 0;
			case '<':
				return c < 0;
			case '^':
				return c >= 0 && v[0] === target[0] && (target[0] > 0 || v[1] === target[1]);
			case '~':
				return c >= 0 && v[0] === target[0] && v[1] === target[1];
			default:
				return c === 0;
		}
	});
}
