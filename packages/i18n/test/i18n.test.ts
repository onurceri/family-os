import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	addCatalogs,
	buildResources,
	type Catalog,
	type Catalogs,
	catalogCoverage,
	checkNamespace,
	coverage,
	createI18n,
	isLocale,
	languageName,
	MAX_PACK_BYTES,
	MAX_STRING_BYTES,
	negotiateLocale,
	PackManifestSchema,
	packFingerprint,
	satisfiesRange,
	textDirection,
	validatePack,
	withOwnTranslations,
} from '../src/index.ts';
import {
	listPackDirsSync,
	readCheckoutCatalogs,
	readPackDir,
	readPackDirSync,
	writePackDir,
} from '../src/node.ts';

const english: Catalogs = {
	app: {
		greeting: 'Hello, {{name}}',
		only_english: 'Only EN',
		items_one: '{{count}} item',
		items_other: '{{count}} items',
		nested: { deep: 'Deep {{x}}' },
	},
	lists: { title: 'Lists' },
};

const manifest = {
	code: 'tr',
	name: 'Turkish',
	nativeName: 'Türkçe',
	version: '1.0.0',
	famos: '>=0.1.0',
};

const turkish = {
	manifest,
	catalogs: {
		app: {
			greeting: 'Merhaba, {{name}}',
			only_english: 'Yalnızca İngilizce',
			items_one: '{{count}} öğe',
			items_other: '{{count}} öğe',
			nested: { deep: 'Derin {{x}}' },
		},
		lists: { title: 'Listeler' },
	},
};

describe('language codes', () => {
	it('accepts BCP 47 tags and rejects the rest', () => {
		expect(isLocale('tr')).toBe(true);
		expect(isLocale('pt-BR')).toBe(true);
		expect(isLocale('not a locale')).toBe(false);
		expect(isLocale('')).toBe(false);
		expect(isLocale(42)).toBe(false);
	});

	it('negotiates from browser preferences among the available packs', () => {
		const available = ['en', 'tr', 'pt-BR'];
		expect(negotiateLocale(['tr-TR', 'en-US'], available)).toBe('tr');
		expect(negotiateLocale(['pt-BR'], available)).toBe('pt-BR');
		// A language without region finds its regional variant; a region without a pack finds the language.
		expect(negotiateLocale(['pt'], available)).toBe('pt-BR');
		expect(negotiateLocale(['pt-PT'], available)).toBe('pt-BR');
		expect(negotiateLocale(['de-DE'], available)).toBe('en');
		// Only English is known by default.
		expect(negotiateLocale(['tr-TR'])).toBe('en');
	});

	it('names languages and reading directions from Intl', () => {
		expect(languageName('tr')).toBe('Turkish');
		expect(languageName('pt-BR')).toMatch(/Portuguese/);
		expect(textDirection('tr')).toBe('ltr');
		expect(textDirection('ar')).toBe('rtl');
	});
});

describe('manifest', () => {
	it('canonicalises the code and refuses English', () => {
		expect(PackManifestSchema.parse({ ...manifest, code: 'pt-br' }).code).toBe('pt-BR');
		expect(PackManifestSchema.safeParse({ ...manifest, code: 'en' }).success).toBe(false);
		expect(PackManifestSchema.safeParse({ ...manifest, code: 'x y' }).success).toBe(false);
	});

	it('requires names, a version and a version range', () => {
		expect(PackManifestSchema.safeParse({ ...manifest, version: 'one' }).success).toBe(false);
		expect(PackManifestSchema.safeParse({ ...manifest, name: '' }).success).toBe(false);
		const { famos: _famos, ...noRange } = manifest;
		expect(PackManifestSchema.safeParse(noRange).success).toBe(false);
		expect(PackManifestSchema.safeParse({ ...manifest, dir: 'up' }).success).toBe(false);
		expect(
			PackManifestSchema.safeParse({ ...manifest, dir: 'rtl', authors: ['A. Person'] }).success,
		).toBe(true);
	});

	it('matches app versions against ranges', () => {
		expect(satisfiesRange('0.1.0', '>=0.1.0')).toBe(true);
		expect(satisfiesRange('0.0.9', '>=0.1.0')).toBe(false);
		expect(satisfiesRange('1.4.2', '^1.2.0')).toBe(true);
		expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false);
		expect(satisfiesRange('0.3.1', '~0.3.0')).toBe(true);
		expect(satisfiesRange('0.4.0', '~0.3.0')).toBe(false);
		expect(satisfiesRange('1.5.0', '>=1.0.0 <2')).toBe(true);
		expect(satisfiesRange('2.0.0', '>=1.0.0 <2')).toBe(false);
		expect(satisfiesRange('9.9.9', '*')).toBe(true);
		expect(satisfiesRange('1.0.0', 'nonsense')).toBe(false);
	});
});

describe('pack validation', () => {
	it('accepts a complete pack with no problems and full coverage', () => {
		const result = validatePack(turkish, english, { appVersion: '0.1.0' });
		if (!result.ok) throw new Error(result.error);
		expect(result.problems).toEqual([]);
		expect(coverage(english, result.pack).ratio).toBe(1);
	});

	it('refuses a bad manifest, a wrong app version, missing catalogs and non-packs', () => {
		const bad = validatePack({ manifest: { ...manifest, code: 'x y' }, catalogs: {} }, english);
		expect(bad.ok).toBe(false);
		const tooNew = validatePack(
			{ manifest: { ...manifest, famos: '>=9.0.0' }, catalogs: {} },
			english,
			{ appVersion: '0.1.0' },
		);
		expect(tooNew.ok).toBe(false);
		expect(validatePack({ manifest }, english).ok).toBe(false);
		expect(validatePack('pack', english).ok).toBe(false);
		expect(validatePack(null, english).ok).toBe(false);
	});

	it('reports unknown keys, and leaves out the namespaces of extensions not installed', () => {
		const result = validatePack(
			{
				manifest,
				catalogs: {
					app: { greeting: 'Merhaba, {{name}}', surprise: 'Sürpriz' },
					elsewhere: { a: 'b' },
				},
			},
			english,
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.problems).toEqual([{ namespace: 'app', key: 'surprise', kind: 'unknown_key' }]);
		expect(result.pack.catalogs).toEqual({ app: { greeting: 'Merhaba, {{name}}' } });
	});

	it('takes a pack that lacks an installed extension, which only lowers its coverage', () => {
		const result = validatePack({ manifest, catalogs: { app: turkish.catalogs.app } }, english);
		if (!result.ok) throw new Error(result.error);
		expect(result.problems).toEqual([]);
		const covered = coverage(english, result.pack);
		expect(covered.missing).toEqual([{ namespace: 'lists', key: 'title' }]);
		expect(covered.ratio).toBeLessThan(1);
	});

	it("shows the pack's strings over an extension's own translation, and fills in from it", () => {
		const result = validatePack(
			{ manifest, catalogs: { app: turkish.catalogs.app, lists: { title: 'Paket' } } },
			english,
		);
		if (!result.ok) throw new Error(result.error);
		const own = { lists: { title: 'Listeler' }, missing: { a: 'b' } };
		expect(withOwnTranslations(result.pack, own, english).pack.catalogs.lists).toEqual({
			title: 'Paket',
		});
		const { app } = result.pack.catalogs;
		const alone = validatePack({ manifest, catalogs: { app } }, english);
		if (!alone.ok) throw new Error(alone.error);
		const shown = withOwnTranslations(alone.pack, own, english);
		expect(shown.problems).toEqual([]);
		expect(shown.pack.catalogs.lists).toEqual({ title: 'Listeler' });
		expect(coverage(english, shown.pack).ratio).toBe(1);
		// The extension's strings are checked like a pack's.
		const bad = withOwnTranslations(alone.pack, { lists: { title: '{{x}}' } }, english);
		expect(bad.problems).toEqual([{ namespace: 'lists', key: 'title', kind: 'placeholders' }]);
		expect(bad.pack.catalogs.lists).toBeUndefined();
	});

	it('drops a string whose placeholders differ from English', () => {
		const result = validatePack(
			{
				manifest,
				catalogs: { app: { greeting: 'Merhaba, {{isim}}', nested: { deep: 'Derin' } } },
			},
			english,
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.problems).toEqual([
			{ namespace: 'app', key: 'greeting', kind: 'placeholders' },
			{ namespace: 'app', key: 'nested.deep', kind: 'placeholders' },
		]);
		expect(result.pack.catalogs).toEqual({});
	});

	it('drops strings that are not text or are too long, and refuses an oversized pack', () => {
		const long = 'x'.repeat(MAX_STRING_BYTES + 1);
		const result = validatePack(
			{
				manifest,
				catalogs: { app: { greeting: long, only_english: 5, nested: { deep: 'Derin {{x}}' } } },
			},
			english,
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.problems).toEqual([
			{ namespace: 'app', key: 'greeting', kind: 'too_long' },
			{ namespace: 'app', key: 'only_english', kind: 'not_text' },
		]);
		const huge = validatePack(
			{ manifest, catalogs: { app: { greeting: 'x'.repeat(MAX_PACK_BYTES) } } },
			english,
		);
		expect(huge).toEqual({ ok: false, error: 'The pack is larger than 2 MB' });
	});

	it('accepts the plural forms of the language, which English may not have', () => {
		const arabic = validatePack(
			{
				manifest: { ...manifest, code: 'ar', name: 'Arabic', nativeName: 'العربية' },
				catalogs: {
					app: {
						items_zero: 'لا عناصر',
						items_one: 'عنصر',
						items_two: 'عنصران',
						items_few: '{{count}} عناصر',
						items_many: '{{count}} عنصرا',
						items_other: '{{count}} عنصر',
					},
				},
			},
			english,
		);
		if (!arabic.ok) throw new Error(arabic.error);
		expect(arabic.problems).toEqual([]);
		expect(Object.keys(arabic.pack.catalogs.app ?? {})).toHaveLength(6);
		// A language with one form (Japanese) is complete with `_other` alone.
		const japanese = validatePack(
			{
				manifest: { ...manifest, code: 'ja', name: 'Japanese', nativeName: '日本語' },
				catalogs: { app: { items_other: '{{count}}個' } },
			},
			english,
		);
		if (!japanese.ok) throw new Error(japanese.error);
		const covered = coverage(english, japanese.pack);
		expect(covered.missing.map((m) => m.key)).not.toContain('items');
		// But Turkish (one + other) missing `_one` is incomplete.
		const partial = validatePack(
			{ manifest, catalogs: { app: { items_other: '{{count}} öğe' } } },
			english,
		);
		if (!partial.ok) throw new Error(partial.error);
		expect(coverage(english, partial.pack).missing.map((m) => m.key)).toContain('items');
	});
});

describe('coverage and the fingerprint', () => {
	it('counts translated English strings, plural groups once', () => {
		const result = validatePack(
			{ manifest, catalogs: { app: { greeting: 'Merhaba, {{name}}' } } },
			english,
		);
		if (!result.ok) throw new Error(result.error);
		const covered = coverage(english, result.pack);
		// greeting, only_english, items (group), nested.deep, lists.title
		expect(covered.total).toBe(5);
		expect(covered.translated).toBe(1);
		expect(covered.ratio).toBeCloseTo(0.2);
		expect(covered.missing).toContainEqual({ namespace: 'lists', key: 'title' });
	});

	it('changes the fingerprint when the content changes', () => {
		const a = validatePack(turkish, english);
		const b = validatePack(
			{ ...turkish, catalogs: { ...turkish.catalogs, lists: { title: 'Liste' } } },
			english,
		);
		if (!a.ok || !b.ok) throw new Error('invalid');
		expect(packFingerprint(a.pack)).toBe(packFingerprint(a.pack));
		expect(packFingerprint(a.pack)).not.toBe(packFingerprint(b.pack));
	});
});

describe('merge with English', () => {
	it('translates with interpolation and plurals, and falls back to English', () => {
		const result = validatePack(
			{
				manifest,
				catalogs: {
					app: {
						greeting: 'Merhaba, {{name}}',
						items_one: '{{count}} öğe',
						items_other: '{{count}} öğe',
					},
				},
			},
			english,
		);
		if (!result.ok) throw new Error(result.error);
		const resources = buildResources(
			Object.entries(english).map(([namespace, catalog]) => ({ namespace, locale: 'en', catalog })),
		);
		const i18n = createI18n({ resources, locale: 'en', defaultNS: 'app' });
		addCatalogs(i18n, 'tr', result.pack.catalogs);
		void i18n.changeLanguage('tr');
		expect(i18n.t('greeting', { name: 'Deniz' })).toBe('Merhaba, Deniz');
		expect(i18n.t('items', { count: 2 })).toBe('2 öğe');
		// Not translated: English.
		expect(i18n.t('only_english')).toBe('Only EN');
		expect(i18n.t('lists:title')).toBe('Lists');
		void i18n.changeLanguage('en');
		expect(i18n.t('items', { count: 1 })).toBe('1 item');
	});

	it('rejects an invalid code and a duplicate catalog when building resources', () => {
		expect(() => buildResources([{ namespace: 'app', locale: 'x y', catalog: {} }])).toThrow();
		expect(() =>
			buildResources([
				{ namespace: 'app', locale: 'tr', catalog: {} },
				{ namespace: 'app', locale: 'tr', catalog: {} },
			]),
		).toThrow(/Duplicate/);
	});
});

describe('pack folders', () => {
	const dirs: string[] = [];
	afterAll(async () => {
		for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	});

	it('round-trips through disk', async () => {
		const root = await mkdtemp(join(tmpdir(), 'famos-pack-'));
		dirs.push(root);
		const result = validatePack(turkish, english);
		if (!result.ok) throw new Error(result.error);
		await writePackDir(join(root, 'tr'), result.pack);
		expect(listPackDirsSync(root)).toEqual(['tr']);
		const raw = await readPackDir(join(root, 'tr'));
		expect(readPackDirSync(join(root, 'tr'))).toEqual(raw);
		const again = validatePack(raw, english);
		expect(again.ok && again.problems).toEqual([]);
		expect(listPackDirsSync(join(root, 'missing'))).toEqual([]);
	});

	it('refuses a namespace that is not a plain name', async () => {
		const root = await mkdtemp(join(tmpdir(), 'famos-pack-'));
		dirs.push(root);
		await expect(
			writePackDir(join(root, 'xx'), { manifest, catalogs: { '../escape': {} } }),
		).rejects.toThrow(/Invalid namespace/);
	});
});

/**
 * The bundled languages must be valid and 100% complete: each bundled pack holds the app's own
 * strings, and every bundled extension ships the same languages in its `src/messages`.
 */
describe('bundled translations', () => {
	const root = resolve(import.meta.dirname, '../../..');
	const { english, translations } = readCheckoutCatalogs(root);
	const codes = listPackDirsSync(join(root, 'languages'));

	it('every pack in languages/ holds only the app strings, valid and complete', async () => {
		expect(codes).toContain('tr');
		for (const code of codes) {
			const raw = await readPackDir(join(root, 'languages', code));
			expect(Object.keys(raw.catalogs), `${code}: an extension's strings live with it`).toEqual([
				'app',
			]);
			const result = validatePack(raw, english);
			if (!result.ok) throw new Error(`${code}: ${result.error}`);
			expect(result.pack.manifest.code, `${code}: folder name`).toBe(code);
			expect(result.problems, `${code}: problems`).toEqual([]);
			const app = catalogCoverage({ app: english.app as Catalog }, result.pack.catalogs, code);
			expect(app.missing, `${code}: missing app strings`).toEqual([]);
		}
	});

	it('every bundled extension ships each bundled language, valid and complete', () => {
		const extensions = Object.keys(english).filter((namespace) => namespace !== 'app');
		expect(extensions.length).toBeGreaterThan(5);
		for (const id of extensions) {
			const base = english[id] as Catalog;
			const shipped = readdirSync(join(root, 'extensions', id, 'src/messages'))
				.filter((f) => f.endsWith('.json') && f !== 'en.json')
				.map((f) => f.slice(0, -'.json'.length));
			for (const code of codes) expect(shipped, `${id}: ${code}.json`).toContain(code);
			for (const code of shipped) {
				const raw = JSON.parse(
					readFileSync(join(root, 'extensions', id, 'src/messages', `${code}.json`), 'utf8'),
				);
				const checked = checkNamespace(id, base, raw, code);
				expect(checked.problems, `${id}/${code}: problems`).toEqual([]);
				const covered = catalogCoverage({ [id]: base }, { [id]: checked.catalog }, code);
				expect(covered.missing, `${id}/${code}: missing strings`).toEqual([]);
			}
		}
	});

	it('every bundled language is complete as the app shows it', async () => {
		for (const code of codes) {
			const result = validatePack(await readPackDir(join(root, 'languages', code)), english);
			if (!result.ok) throw new Error(`${code}: ${result.error}`);
			const shown = withOwnTranslations(result.pack, translations[code] ?? {}, english);
			expect(coverage(english, shown.pack).ratio, code).toBe(1);
		}
	});
});

describe('registering a namespace later', () => {
	it('reads an extension catalog added after start, in English and in a pack', () => {
		const i18n = createI18n({
			resources: { en: { app: { nav_more: 'More' } } },
			locale: 'en',
			defaultNS: 'app',
		});
		expect(i18n.exists('garden:beds')).toBe(false);
		addCatalogs(i18n, 'en', { garden: { beds: 'Beds', rows: 'Rows' } });
		expect(i18n.t('garden:beds')).toBe('Beds');
		addCatalogs(i18n, 'tr', { garden: { beds: 'Tarhlar' } });
		expect(i18n.t('garden:beds', { lng: 'tr' })).toBe('Tarhlar');
		expect(i18n.t('garden:rows', { lng: 'tr' })).toBe('Rows');
	});
});
