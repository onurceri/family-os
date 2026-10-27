import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
 *    older browser keeps the line it understands. In markup use the utilities of
 *    `packages/ui/src/theme.css` (`h-viewport`, `min-h-viewport`, `h-shell-fill` ...), not
 *    Tailwind's `h-dvh`.
 * 3. A `color-mix()` comes right after the same property with a plain token color, for the same
 *    reason. In markup use a named utility from `theme.css` (`bg-ink-pressed` ...), not an
 *    arbitrary `bg-[color-mix(...)]` class. A custom property cannot fall back that way: set it
 *    inside `@supports (color: color-mix(in srgb, red, blue))`.
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

const STYLE = /<style[^>]*>([\s\S]*?)<\/style>/gi;

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
	for (const match of code.matchAll(/(<script[^>]*>)([\s\S]*?)(<\/script>)/gi)) {
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

/** Tailwind classes and inline styles that cannot carry a fallback line. */
function classOffenders(code: string): string[] {
	const found: string[] = [];
	for (const match of code.matchAll(/[\w:[\]()-]*\d?(?:dvh|svh|lvh)\b[\w\]()-]*/g)) {
		const line = code.slice(0, match.index).split('\n').length;
		found.push(
			`line ${line}: \`${match[0]}\` has no \`vh\` fallback; use a viewport utility of theme.css`,
		);
	}
	// Tailwind's `bg-now/5` falls back to a solid block over the text before Chrome 111.
	for (const match of code.matchAll(/(?<![\w-])bg-[a-z][\w-]*\/(\d+(?:\.\d+)?)(?![\w.%])/g)) {
		if (Number(match[1]) >= 50) continue;
		const line = code.slice(0, match.index).split('\n').length;
		found.push(
			`line ${line}: \`${match[0]}\` falls back to a solid color; use \`tint-<color>/<n>\` (or \`track-\` for a switch track)`,
		);
	}
	// Code that tests `colorMixSupported` picks its own fallback.
	const mixes = code.includes('colorMixSupported')
		? []
		: [...code.matchAll(/[\w:-]*\[?[^\s"'`]*color-mix\([^\s"'`]*/g)];
	for (const match of mixes) {
		const line = code.slice(0, match.index).split('\n').length;
		found.push(
			`line ${line}: \`${match[0]}\` has no plain fallback; use a named utility of theme.css`,
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
			const ok =
				!custom && previous && PLAIN_VH.test(previous.value) && !VIEWPORT.test(previous.value);
			if (!ok) found.push(`${shown}: put the same property in \`vh\` right before it`);
		}
		if (at.value.includes('color-mix(') && !supports.includes('color-mix')) {
			const ok = !custom && previous && !previous.value.includes('color-mix(');
			if (!ok) {
				found.push(
					custom
						? `${shown}: a custom property cannot fall back; set it inside @supports (color: color-mix(in srgb, red, blue))`
						: `${shown}: put the same property with a plain token color right before it`,
				);
			}
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

	it('finds a viewport unit or color-mix without a fallback line', () => {
		expect(cssOffenders('.a { height: 100dvh; }')).toHaveLength(1);
		expect(cssOffenders('.a { height: 100vh; height: 100dvh; }')).toEqual([]);
		expect(cssOffenders('.a { min-height: 100vh; height: 100dvh; }')).toHaveLength(1);
		expect(cssOffenders('.a { height: calc(100vh - 1rem); height: calc(100dvh - 1rem); }')).toEqual(
			[],
		);
		expect(cssOffenders('.a { background: color-mix(in oklab, red 10%, blue); }')).toHaveLength(1);
		expect(
			cssOffenders(
				'.a { background: var(--idle); background: color-mix(in oklab, var(--idle) 10%, blue); }',
			),
		).toEqual([]);
		expect(cssOffenders('.a { --x: color-mix(in oklab, red, blue); }')).toHaveLength(1);
		expect(
			cssOffenders('.a { height: 100vh; @supports (height: 100dvh) { height: 100dvh; } }'),
		).toEqual([]);
		expect(
			cssOffenders(
				'@supports (color: color-mix(in srgb, red, blue)) { .a { --x: color-mix(in oklab, red, blue); } }',
			),
		).toEqual([]);
	});

	it('finds a Tailwind class that cannot carry a fallback', () => {
		expect(classOffenders('<div class="h-dvh min-h-dvh max-h-[40dvh]">')).toHaveLength(3);
		expect(classOffenders('<div class="h-viewport hover:bg-ink-pressed">')).toEqual([]);
		expect(classOffenders('<div class="bg-now/5 hover:bg-idle/60 bg-ink-soft/35">')).toHaveLength(
			2,
		);
		expect(classOffenders('<div class="tint-now/5 bg-idle/55">')).toEqual([]);
		expect(
			classOffenders('<div class="hover:bg-[color-mix(in_oklab,var(--ink)_86%,red)]">'),
		).toHaveLength(1);
	});

	it('uses no API newer than Chrome 106 in browser code', () => {
		const offenders = SOURCES.flatMap((dir) => [...walk(join(root, dir))]).flatMap((path) =>
			newApis(codeOf(path, readFileSync(path, 'utf8'))).map(
				(problem) => `${path.slice(root.length + 1)} ${problem}`,
			),
		);
		expect(offenders).toEqual([]);
	});

	it('gives every viewport unit and color-mix a line an older browser understands', () => {
		const offenders = SOURCES.flatMap((dir) => [...walk(join(root, dir))]).flatMap((path) => {
			const text = readFileSync(path, 'utf8');
			return [...cssOffenders(cssOf(path, text)), ...classOffenders(codeOf(path, text))].map(
				(problem) => `${path.slice(root.length + 1)} ${problem}`,
			);
		});
		expect(offenders).toEqual([]);
	});
});
