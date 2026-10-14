// Tools for translators (docs/guide/languages.md):
//   pnpm lang:template <code> [outDir]   writes a fresh pack skeleton from the English catalogs
//   pnpm lang:check <dir> [--complete]   prints coverage and problems of a pack folder, or of the
//                                        translations an extension folder ships
// Run by Node directly (type stripping); no build step.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type Catalog,
	type Catalogs,
	type Coverage,
	canonicalLocale,
	catalogCoverage,
	checkNamespace,
	coverage,
	flatten,
	languageName,
	MAX_PACK_BYTES,
	type PackProblem,
	pluralCategories,
	validatePack,
	withOwnTranslations,
} from '../packages/i18n/src/index.ts';
import { readCheckoutCatalogs, readPackDir } from '../packages/i18n/src/node.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);

const ADVICE: Record<PackProblem['kind'], string> = {
	unknown_key: 'no such key in English (renamed or removed?); ignored',
	not_text: 'not a string; ignored',
	placeholders: 'the {{placeholders}} differ from English; this string is dropped',
	too_long: 'longer than 4 KB; this string is dropped',
};

async function template(code: string | undefined, outDir: string | undefined) {
	const canonical = canonicalLocale(code);
	if (!canonical || canonical === 'en') {
		console.error(
			'Usage: pnpm lang:template <code> [dir]   (a BCP 47 code such as de or pt-BR, not en)',
		);
		return 2;
	}
	const dir = resolve(outDir ?? join(root, 'languages', canonical));
	const { english } = readCheckoutCatalogs(root);
	try {
		await mkdir(dir);
	} catch {
		console.error(`${dir} exists already. Edit it, or pick another directory.`);
		return 1;
	}
	const manifest = {
		code: canonical,
		name: languageName(canonical),
		nativeName: new Intl.DisplayNames([canonical], { type: 'language' }).of(canonical) ?? canonical,
		version: '0.1.0',
		famos: '>=0.1.0',
		authors: [],
	};
	await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	// The English text is the starting value: change each string in place. A string left as English
	// reads fine meanwhile; `pnpm lang:check` counts how many are still identical to English.
	for (const [namespace, catalog] of Object.entries(english)) {
		await writeFile(join(dir, `${namespace}.json`), `${JSON.stringify(catalog, null, '\t')}\n`);
	}
	const forms = pluralCategories(canonical);
	console.log(`Wrote ${dir}`);
	console.log(`Plural forms of ${canonical}: ${forms.join(', ')}.`);
	console.log(
		'Plural strings come as _one and _other (English). Add the others your language needs (for example _few) and drop what it does not.',
	);
	return 0;
}

/** Prints the problems and the first missing strings; the exit code the check ends with. */
function report(problems: readonly PackProblem[], covered: Coverage, complete: boolean): number {
	for (const p of problems) {
		console.log(`  problem  ${p.namespace}${p.key ? `:${p.key}` : ''}  ${ADVICE[p.kind]}`);
	}
	for (const m of covered.missing.slice(0, 20)) console.log(`  missing  ${m.namespace}:${m.key}`);
	if (covered.missing.length > 20)
		console.log(`  … and ${covered.missing.length - 20} more missing`);
	if (problems.length > 0) {
		console.error(`${problems.length} problem(s) found.`);
		return 1;
	}
	if (complete && covered.missing.length > 0) {
		console.error(`${covered.missing.length} string(s) missing and --complete was given.`);
		return 1;
	}
	return 0;
}

/** Strings still equal to English: often a translator's placeholder, sometimes a proper name. */
function sameAsEnglish(english: Catalogs, catalogs: Catalogs): number {
	let same = 0;
	for (const [namespace, catalog] of Object.entries(catalogs)) {
		const base = flatten(english[namespace] ?? {});
		for (const [key, text] of flatten(catalog)) if (base.get(key) === text) same++;
	}
	return same;
}

const percent = (c: Coverage) =>
	`${c.translated} of ${c.total} strings translated (${Math.floor(c.ratio * 100)}%)`;

/**
 * A pack folder, checked against the English of every extension in this checkout. Its coverage
 * counts the translations the extensions ship of the same language, as the app shows them.
 */
async function checkPack(dir: string, complete: boolean) {
	const { english, translations } = readCheckoutCatalogs(root);
	let raw: Awaited<ReturnType<typeof readPackDir>>;
	try {
		raw = await readPackDir(resolve(dir));
	} catch (error) {
		console.error(`Cannot read ${dir}: ${error instanceof Error ? error.message : error}`);
		return 1;
	}
	const result = validatePack(raw, english);
	if (!result.ok) {
		console.error(`Invalid pack: ${result.error}`);
		return 1;
	}
	const { pack, problems } = result;
	const shown = withOwnTranslations(pack, translations[pack.manifest.code] ?? {}, english);
	const covered = coverage(english, shown.pack);
	const size = new TextEncoder().encode(
		JSON.stringify({ manifest: pack.manifest, catalogs: pack.catalogs }),
	).length;
	console.log(
		`${pack.manifest.nativeName} (${pack.manifest.code}) ${pack.manifest.version}: ${percent(covered)} with the extensions' own translations, ${(size / 1024).toFixed(0)} KB of ${MAX_PACK_BYTES / 1024 / 1024} MB`,
	);
	const unknown = Object.keys(raw.catalogs).filter((namespace) => !english[namespace]);
	if (unknown.length > 0)
		console.log(
			`Note: no extension here is called ${unknown.join(', ')}; those files are ignored.`,
		);
	const same = sameAsEnglish(english, pack.catalogs);
	if (same > 0)
		console.log(`Note: ${same} strings are identical to English (fine for names; check the rest).`);
	const code = report([...problems, ...shown.problems], covered, complete);
	if (code === 0) console.log('OK');
	return code;
}

/** An extension folder: each `src/messages/<code>.json` it ships, checked against its `en.json`. */
function checkExtension(dir: string, complete: boolean) {
	const messages = join(resolve(dir), 'src/messages');
	const read = (file: string) => JSON.parse(readFileSync(join(messages, file), 'utf8')) as Catalog;
	const pkg = JSON.parse(readFileSync(join(resolve(dir), 'package.json'), 'utf8')) as {
		famos?: { id?: string };
	};
	const id = pkg.famos?.id;
	if (!id) {
		console.error(`${dir} has no "famos" manifest in its package.json`);
		return 1;
	}
	const english: Catalogs = { [id]: read('en.json') };
	const files = readdirSync(messages).filter((f) => f.endsWith('.json') && f !== 'en.json');
	if (files.length === 0) console.log(`${id}: English only`);
	let code = 0;
	for (const file of files) {
		const language = canonicalLocale(file.slice(0, -'.json'.length));
		if (!language || language === 'en') {
			console.error(`  ${file}: not named after a language code`);
			code = 1;
			continue;
		}
		const checked = checkNamespace(id, english[id] as Catalog, read(file), language);
		const covered = catalogCoverage(english, { [id]: checked.catalog }, language);
		console.log(`${id} (${language}): ${percent(covered)}`);
		code = Math.max(code, report(checked.problems, covered, complete));
	}
	if (code === 0) console.log('OK');
	return code;
}

async function check(dir: string | undefined, complete: boolean) {
	if (!dir) {
		console.error('Usage: pnpm lang:check <dir> [--complete]');
		return 2;
	}
	if (
		!existsSync(join(resolve(dir), 'manifest.json')) &&
		existsSync(join(resolve(dir), 'src/messages/en.json'))
	)
		return checkExtension(dir, complete);
	return checkPack(dir, complete);
}

async function run(): Promise<number> {
	if (command === 'template') return template(args[0], args[1]);
	if (command === 'check') {
		return check(
			args.find((a) => !a.startsWith('--')),
			args.includes('--complete'),
		);
	}
	console.error('Usage: lang.ts template <code> [dir] | check <dir> [--complete]');
	return 2;
}

process.exit(await run());
