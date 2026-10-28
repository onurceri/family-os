import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	colorMixFallback,
	type ResolveChannels,
	resolveByConvention,
} from '../packages/pack/src/color-fallback.ts';
import { MODE_TOKENS } from '../packages/themes/src/tokens.ts';

/**
 * FamilyOS opens on Chrome (and Android WebView) 106: that is what old Android photo frames and
 * fridge browsers used as wall displays run. A browser that meets something it lacks does not
 * degrade, it stops: a missing method ends the start of the app, a missing unit leaves a page
 * with no height, a missing color function leaves a surface unpainted. So browser code follows
 * three rules, and this test fails on the code that breaks one:
 *
 * 1. No JavaScript API newer than Chrome 106, except the array copy methods `apps/web/src/compat.ts`
 *    installs from core-js. Use a loop or a helper instead of `Object.groupBy`, the Set methods
 *    (`union`, `intersection` ...), `Promise.withResolvers`, iterator helpers and the like.
 * 2. A viewport height in `dvh`, `svh` or `lvh` comes right after the same property in `vh`, so an
 *    older browser keeps the line it understands. A value with a `var()` goes inside
 *    `@supports (height: 100dvh)` instead: such a line is accepted when the sheet is read and
 *    dropped only when it is computed, so it would win over the `vh` line. In markup use the utilities of
 *    `packages/ui/src/theme.css` (`h-viewport`, `min-h-viewport`, `h-shell-fill` ...), not
 *    Tailwind's `h-dvh`.
 * 3. Every `color-mix()` is one the build can write a fallback for (`@famos/pack`'s
 *    `colorMixFallback`, applied to every stylesheet and component style): in `srgb` or `oklab`,
 *    of `transparent`, hex, `rgb()`, nested mixes and variables that carry channels. Those are the
 *    theme's tokens, custom properties a stylesheet sets to a color (`--lamp: var(--board)`), and
 *    colors set from script with `colorVars` (`style={colorVars('m', member.color)}`), never with
 *    a bare `style:--m=` (that sets no channels). Script that writes a mix itself computes its own
 *    fallback and says so by testing `colorMixSupported`.
 */
const root = join(import.meta.dirname, '..');

const SOURCES = [
	'apps/web/src',
	'packages/ui/src',
	'packages/time/src',
	'packages/sdk/src',
	'packages/i18n/src',
	...readdirSync(join(root, 'extensions')).map((id) => `extensions/${id}/src/web`),
];

function* walk(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name === 'dist' || name === 'build') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (/\.(svelte|css|ts|js)$/.test(name) && !/\.(test|d|gen\.d)\.ts$/.test(name)) yield path;
	}
}

const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\b[^>]*>/gi;

/** A file's stylesheet(s): a component's `<style>` blocks, or the whole stylesheet. */
const cssOf = (path: string, text: string): string =>
	path.endsWith('.css')
		? text
		: [...text.matchAll(STYLE)].map((match) => match[1] ?? '').join('\n');

/** A file's script and markup: everything but its `<style>` blocks, comments blanked. */
function codeOf(path: string, text: string): string {
	if (path.endsWith('.css')) return '';
	return text
		.replace(STYLE, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:\\])\/\/.*$/gm, (_, before: string) => before);
}

/** The script of a file, the rest blanked so positions still line up; a plain script is all script. */
function scriptOf(code: string): string {
	return /<script/i.test(code) ? blankOutsideScript(code) : code;
}

function blankOutsideScript(code: string): string {
	const blank = (text: string) => text.replace(/[^\n]/g, ' ');
	let out = '';
	let at = 0;
	for (const match of code.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script\b[^>]*>)/gi)) {
		const start = match.index ?? 0;
		out +=
			blank(code.slice(at, start)) +
			blank(match[1] ?? '') +
			(match[2] ?? '') +
			blank(match[3] ?? '');
		at = start + match[0].length;
	}
	return out + blank(code.slice(at));
}

const GLOBALS = String.raw`\b(?:Object\.groupBy|Map\.groupBy|Promise\.withResolvers|Promise\.try|Array\.fromAsync|Iterator\.from|URL\.canParse|AbortSignal\.any)\b`;
/** Set methods, but not zod's `z.union(` and `z.intersection(`. */
const SET_METHODS = String.raw`(?<!\bz)\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(`;
/** Iterator helpers on `.values()`, `.keys()` or `.entries()` (of an array, a Map or a Set). */
const ITERATOR_HELPERS = String.raw`\.(?:values|keys|entries)\(\)\s*\.(?:map|filter|take|drop|flatMap|reduce|some|every|find|forEach|toArray)\(`;
const WELL_FORMED = String.raw`\.(?:isWellFormed|toWellFormed)\(`;
/** A regular expression literal with the `v` flag. */
const V_FLAG = String.raw`(?:^|[=(:,!&|?{};\s])\/(?![\/*])(?:[^\/\n\\\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuy]*v[dgimsuy]*(?![\w$])`;

const API_RULES: readonly [RegExp, string][] = [
	[new RegExp(GLOBALS, 'g'), 'is newer than Chrome 106'],
	[new RegExp(SET_METHODS, 'g'), 'is a Set method newer than Chrome 106'],
	[new RegExp(ITERATOR_HELPERS, 'g'), 'is an iterator helper newer than Chrome 106'],
	[new RegExp(WELL_FORMED, 'g'), 'is newer than Chrome 106'],
];

/** The uses of an API newer than Chrome 106 in script and markup. */
function newApis(code: string): string[] {
	const found: string[] = [];
	for (const [pattern, why] of API_RULES) {
		for (const match of code.matchAll(pattern)) {
			const line = code.slice(0, match.index).split('\n').length;
			found.push(`line ${line}: \`${match[0].trim()}\` ${why}`);
		}
	}
	// Markup has `/>` and `</div` runs that read like a literal, so only script is searched.
	for (const match of scriptOf(code).matchAll(new RegExp(V_FLAG, 'gm'))) {
		const line = code.slice(0, match.index).split('\n').length;
		found.push(
			`line ${line}: \`${match[0].trim()}\` is a regular expression with the v flag, newer than Chrome 106`,
		);
	}
	return found;
}

/** Tailwind classes that cannot carry a fallback line. */
function classOffenders(code: string): string[] {
	const found: string[] = [];
	for (const match of code.matchAll(/[\w:[\]()-]*\d?(?:dvh|svh|lvh)\b[\w\]()-]*/g)) {
		const line = code.slice(0, match.index).split('\n').length;
		found.push(
			`line ${line}: \`${match[0]}\` has no \`vh\` fallback; use a viewport utility of theme.css`,
		);
	}
	return found;
}

/** Each `color-mix(…)` of a text, whole (nested mixes inside). */
function mixesOf(text: string): string[] {
	const found: string[] = [];
	let at = text.indexOf('color-mix(');
	while (at !== -1) {
		let depth = 0;
		let end = at;
		for (; end < text.length; end++) {
			if (text[end] === '(') depth++;
			else if (text[end] === ')' && --depth === 0) break;
		}
		found.push(text.slice(at, end + 1));
		at = text.indexOf('color-mix(', end);
	}
	return found;
}

/** The mixes of a file's markup and script: arbitrary Tailwind values (`_` for a space) and strings. */
function codeMixes(code: string): { line: number; mix: string }[] {
	const found: { line: number; mix: string }[] = [];
	for (const mix of mixesOf(code)) {
		const line = code.slice(0, code.indexOf(mix)).split('\n').length;
		found.push({ line, mix: mix.replaceAll('_', ' ') });
	}
	return found;
}

const COLOR_TOKENS = Object.entries(MODE_TOKENS)
	.filter(([, info]) => info.kind === 'color')
	.map(([name]) => `--${name}`);

/** A custom property's value, read as what it names: another variable, a color, or a mix. */
const ALIAS = /^var\(\s*(--[\w-]+)\s*(?:,.*)?\)$/s;
const STATIC_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([^()]*\)|transparent)$/i;

/**
 * The custom properties that carry channels, as the build and `colorVars` write them: the theme's
 * tokens (and Tailwind's names for them), what a stylesheet sets to a color, a variable that has
 * channels or a mix it can compute, and what script sets with `colorVars` or `channelDeclarations`.
 */
function channelNames(files: { css: string; code: string }[]): Set<string> {
	const known = new Set([...COLOR_TOKENS, ...COLOR_TOKENS.map((t) => `--color-${t.slice(2)}`)]);
	const declared: { prop: string; value: string }[] = [];
	for (const { css, code } of files) {
		for (const { at } of declarations(css)) if (at.prop.startsWith('--')) declared.push(at);
		for (const match of code.matchAll(/\bcolorVars\(\s*['"`]([\w-]+)['"`]/g))
			known.add(`--${match[1]}`);
		for (const match of code.matchAll(/\bchannelDeclarations\(\s*['"`](--[\w-]+)['"`]/g)) {
			known.add(match[1] as string);
		}
	}
	const resolve = strictResolve(known);
	for (let grew = true; grew; ) {
		grew = false;
		for (const { prop, value } of declared) {
			if (known.has(prop)) continue;
			const target = ALIAS.exec(value)?.[1];
			const ok =
				(target !== undefined && known.has(target)) ||
				STATIC_COLOR.test(value) ||
				(value.startsWith('color-mix(') && colorMixFallback(value, resolve) !== null);
			if (ok) {
				known.add(prop);
				grew = true;
			}
		}
	}
	return known;
}

/** Channels only for the names known to carry them. */
const strictResolve =
	(known: Set<string>): ResolveChannels =>
	(name) =>
		known.has(name) ? resolveByConvention(name) : null;

/** The mixes the build cannot write a fallback for, and inline colors set without channels. */
function mixOffenders(
	{ css, code, script }: { css: string; code: string; script: string },
	known: Set<string>,
	mixed: Set<string>,
): string[] {
	const found: string[] = [];
	const resolve = strictResolve(known);
	for (const { at } of declarations(css)) {
		for (const mix of mixesOf(at.value)) {
			if (colorMixFallback(mix, resolve) === null) {
				found.push(
					`${at.prop}: ${mix} has no fallback the build can compute; mix theme tokens, transparent, or variables set with colorVars`,
				);
			}
		}
	}
	// Script that writes a mix computes its own fallback (`colorMixSupported`).
	if (!script.includes('colorMixSupported')) {
		for (const { line, mix } of codeMixes(code)) {
			if (colorMixFallback(mix, resolve) === null) {
				found.push(`line ${line}: \`${mix}\` has no fallback the build can compute`);
			}
		}
	}
	for (const match of code.matchAll(/\bstyle:(--[\w-]+)\s*=/g)) {
		const name = match[1] as string;
		if (!mixed.has(name) && !COLOR_TOKENS.includes(name)) continue;
		const line = code.slice(0, match.index).split('\n').length;
		found.push(
			`line ${line}: \`style:${name}\` sets a color a mix uses without its channels; use style={colorVars('${name.slice(2)}', …)}`,
		);
	}
	return found;
}

interface Declaration {
	prop: string;
	value: string;
}

/** Each declaration of a stylesheet, with the earlier ones of its block and whether it sits in a `color-mix` `@supports`. */
function declarations(css: string): { at: Declaration; before: Declaration[]; supports: string }[] {
	const found: { at: Declaration; before: Declaration[]; supports: string }[] = [];
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const blocks: { list: Declaration[]; supports: string }[] = [{ list: [], supports: '' }];
	let pending = '';
	let parens = 0;
	const flush = () => {
		const match = /^\s*([-\w]+)\s*:([\s\S]*)$/.exec(pending);
		const block = blocks[blocks.length - 1];
		if (match && block) {
			const at = { prop: match[1] ?? '', value: (match[2] ?? '').replace(/\s+/g, ' ').trim() };
			found.push({ at, before: [...block.list], supports: block.supports });
			block.list.push(at);
		}
		pending = '';
	};
	for (const ch of text) {
		if (ch === '(') parens++;
		else if (ch === ')') parens--;
		if (parens <= 0 && ch === '{') {
			const supports = `${blocks[blocks.length - 1]?.supports ?? ''} ${/^\s*@supports/.test(pending) ? pending : ''}`;
			pending = '';
			blocks.push({ list: [], supports });
		} else if (parens <= 0 && ch === '}') {
			flush();
			if (blocks.length > 1) blocks.pop();
		} else if (parens <= 0 && ch === ';') flush();
		else pending += ch;
	}
	return found;
}

const VIEWPORT = /\d(?:dvh|svh|lvh)\b/;
const PLAIN_VH = /\dvh\b/;

/** The declarations whose newer unit or function has no plain line right before it. */
function cssOffenders(css: string): string[] {
	const found: string[] = [];
	for (const { at, before, supports } of declarations(css)) {
		const shown = `${at.prop}: ${at.value}`;
		const custom = at.prop.startsWith('--');
		const previous = before.filter((d) => d.prop === at.prop).at(-1);
		if (VIEWPORT.test(at.value) && !/vh/.test(supports)) {
			if (at.value.includes('var(')) {
				found.push(
					`${shown}: with a var() the line is kept where dvh is unknown; set it inside @supports (height: 100dvh) after the vh line`,
				);
				continue;
			}
			const ok =
				!custom && previous && PLAIN_VH.test(previous.value) && !VIEWPORT.test(previous.value);
			if (!ok) found.push(`${shown}: put the same property in \`vh\` right before it`);
		}
	}
	return found;
}

describe('older browsers', () => {
	it('finds an API newer than Chrome 106', () => {
		expect(newApis('const a = Object.groupBy(x, f);')).toHaveLength(1);
		expect(newApis('a.union(b); new Set(a).isSubsetOf(b);')).toHaveLength(2);
		expect(newApis('z.union([a, b]); z.intersection(a, b); Object.values(x).map(f);')).toEqual([]);
		expect(newApis('map.values().map((x) => x);')).toHaveLength(1);
		expect(newApis('const re = /[\\p{L}--[a-z]]/v;')).toHaveLength(1);
		expect(newApis('const share = a / b; const other = c / d;')).toEqual([]);
		expect(newApis('list.toSorted(); list.at(-1);')).toEqual([]);
	});

	it('finds a viewport unit without a fallback line', () => {
		expect(cssOffenders('.a { height: 100dvh; }')).toHaveLength(1);
		expect(cssOffenders('.a { height: 100vh; height: 100dvh; }')).toEqual([]);
		expect(cssOffenders('.a { min-height: 100vh; height: 100dvh; }')).toHaveLength(1);
		expect(cssOffenders('.a { height: calc(100vh - 1rem); height: calc(100dvh - 1rem); }')).toEqual(
			[],
		);
		expect(
			cssOffenders('.a { height: 100vh; @supports (height: 100dvh) { height: 100dvh; } }'),
		).toEqual([]);
		expect(
			cssOffenders('.a { height: calc(100vh - var(--x)); height: calc(100dvh - var(--x)); }'),
		).toHaveLength(1);
		expect(
			cssOffenders(
				'.a { height: calc(100vh - var(--x)); } @supports (height: 100dvh) { .a { height: calc(100dvh - var(--x)); } }',
			),
		).toEqual([]);
		expect(classOffenders('<div class="h-dvh min-h-dvh max-h-[40dvh]">')).toHaveLength(3);
		expect(classOffenders('<div class="h-viewport min-h-viewport">')).toEqual([]);
	});

	it('finds a mix the build cannot write a fallback for', () => {
		const file = (css: string, code = '') => ({ css, code, script: code });
		const known = channelNames([
			file(
				'.b { --lamp: var(--board); --drop: color-mix(in srgb, var(--info) 80%, transparent); }',
			),
			file('', "<p style={colorVars('m', color)}></p>"),
		]);
		expect([...known]).toEqual(expect.arrayContaining(['--ink', '--lamp', '--drop', '--m']));
		const offenders = (css: string, code = '') =>
			mixOffenders(file(css, code), known, new Set(['--m']));
		expect(offenders('.a { color: color-mix(in oklab, var(--m) 16%, var(--lamp)); }')).toEqual([]);
		expect(offenders('.a { color: color-mix(in oklab, var(--drop), transparent); }')).toEqual([]);
		expect(offenders('.a { color: color-mix(in oklab, red 10%, blue); }')).toHaveLength(1);
		expect(
			offenders('.a { color: color-mix(in srgb, var(--mystery) 10%, var(--ink)); }'),
		).toHaveLength(1);
		expect(offenders('.a { color: color-mix(in hsl, var(--ink) 10%, transparent); }')).toHaveLength(
			1,
		);
		expect(
			offenders('', '<div class="hover:bg-[color-mix(in_oklab,var(--ink)_86%,var(--surface))]">'),
		).toEqual([]);
		expect(offenders('', '<div class="bg-[color-mix(in_oklab,var(--ink)_86%,red)]">')).toHaveLength(
			1,
		);
		expect(offenders('', '<li style:--m={color}>')).toHaveLength(1);
		expect(offenders('', '<li style:--ink-soft="var(--sky-soft)">')).toHaveLength(1);
		expect(offenders('', "<li style:--o={3} style={colorVars('m', color)}>")).toEqual([]);
	});

	it('uses no API newer than Chrome 106 in browser code', () => {
		const offenders = SOURCES.flatMap((dir) => [...walk(join(root, dir))]).flatMap((path) =>
			newApis(codeOf(path, readFileSync(path, 'utf8'))).map(
				(problem) => `${path.slice(root.length + 1)} ${problem}`,
			),
		);
		expect(offenders).toEqual([]);
	});

	it('gives every viewport unit a line an older browser understands', () => {
		const offenders = SOURCES.flatMap((dir) => [...walk(join(root, dir))]).flatMap((path) => {
			const text = readFileSync(path, 'utf8');
			return [...cssOffenders(cssOf(path, text)), ...classOffenders(codeOf(path, text))].map(
				(problem) => `${path.slice(root.length + 1)} ${problem}`,
			);
		});
		expect(offenders).toEqual([]);
	});

	it('writes only color mixes the build can give a fallback', () => {
		const files = SOURCES.flatMap((dir) => [...walk(join(root, dir))]).map((path) => {
			const text = readFileSync(path, 'utf8');
			const code = codeOf(path, text);
			return { path, css: cssOf(path, text), code, script: scriptOf(code) };
		});
		const known = channelNames(files);
		// Every variable a mix names: an inline style setting one needs its channels too.
		const mixed = new Set(
			files.flatMap(({ css, code }) =>
				mixesOf(`${css}\n${code}`).flatMap((mix) =>
					[...mix.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] as string),
				),
			),
		);
		const offenders = files.flatMap((file) =>
			mixOffenders(file, known, mixed).map(
				(problem) => `${file.path.slice(root.length + 1)} ${problem}`,
			),
		);
		expect(offenders).toEqual([]);
	});
});
