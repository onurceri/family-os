import { type Channels, channelDeclarations, channelsCss } from '@famos/ui/colors';
import {
	type CustomProperty,
	type Declaration,
	type Location2,
	type Rule,
	type SupportsCondition,
	type TokenOrValue,
	transform,
} from 'lightningcss';
import type { Plugin } from 'vite';
import { colorChannelsOf, isColorToken, resolveByConvention } from './color-fallback.ts';
import { BROWSER_TARGETS, lightningTargets, needsColorMixFallback } from './targets.ts';

/**
 * Writes the fallback of every `color-mix()` into a stylesheet, for browsers without it (see
 * `color-fallback.ts` for the math). Applied wherever CSS is born at build: component `<style>`
 * blocks (`componentStylesPreprocessor`), the app's stylesheets (`colorFallbackPlugin`) and an
 * extension's utilities (`buildStyles`). The rules:
 *
 * - `prop: …color-mix(…)…` becomes `prop: …rgb(calc(…))…`, and the declaration with the mix is
 *   set again for the same selector under `@supports (color: color-mix(in srgb, red, red))`,
 *   right after the rule. Two lines of one property in a row would not do: a custom property
 *   takes any value, and lightningcss (also Vite's minifier) keeps only the last `color`, `fill`,
 *   `stroke` or `filter` of a rule, whatever the targets.
 * - A custom property set to a mix also gets the result's channels (`--drop-r` …).
 * - A rule under `@supports (… color-mix …)` (Tailwind's `bg-ink/10`) gets a rule with the
 *   fallback right before the `@supports`, after Tailwind's own solid color, so it wins there.
 * - A custom property set to a color (`--ink: #1d1c1a`, `--lamp: var(--board)`) gets its channels
 *   (`--lamp-r: var(--board-r)` …) in the same rule, so mixes over it work.
 *
 * A mix it cannot compute is left as it is. All of it is on only while the build targets a
 * browser without `color-mix()` (`needsColorMixFallback`).
 */

type Decl = Declaration;
type Tokens = TokenOrValue[];

const MIX_SUPPORTS = '(color: color-mix(in srgb, red, red))';

/** Parses a value into lightningcss tokens, by reading it as a custom property's value. */
const tokenCache = new Map<string, Tokens>();
function tokensOf(value: string): Tokens {
	const cached = tokenCache.get(value);
	if (cached) return cached;
	let found: Tokens | undefined;
	transform({
		filename: 'value.css',
		code: Buffer.from(`a{--v:${value}}`),
		visitor: {
			Declaration(decl) {
				if (decl.property === 'custom') found = decl.value.value;
			},
		},
	});
	if (!found) throw new Error(`Could not read the CSS value ${value}`);
	tokenCache.set(value, found);
	return found;
}

let mixCondition: SupportsCondition | undefined;
/** `(color: color-mix(in srgb, red, red))` as lightningcss's condition. */
function mixSupports(): SupportsCondition {
	if (mixCondition) return mixCondition;
	transform({
		filename: 'supports.css',
		code: Buffer.from(`@supports ${MIX_SUPPORTS}{a{color:red}}`),
		visitor: {
			Rule: {
				supports(rule) {
					mixCondition = rule.value.condition;
				},
			},
		},
	});
	if (!mixCondition) throw new Error('Could not read the @supports condition');
	return mixCondition;
}

const round = (value: number) => String(Number(value.toFixed(4)));

/** A token list as CSS text, or null when it holds a token this does not write. */
function cssOf(tokens: Tokens): string | null {
	let out = '';
	for (const token of tokens) {
		const text = tokenCss(token);
		if (text === null) return null;
		out += text;
	}
	return out;
}

function tokenCss(token: TokenOrValue): string | null {
	switch (token.type) {
		case 'token': {
			const t = token.value;
			switch (t.type) {
				case 'ident':
					return t.value;
				case 'white-space':
					return ' ';
				case 'comma':
					return ',';
				case 'delim':
					return t.value;
				case 'number':
					return round(t.value);
				case 'percentage':
					return `${round(t.value * 100)}%`;
				case 'dimension':
					return `${round(t.value)}${t.unit}`;
				case 'hash':
				case 'id-hash':
					return `#${t.value}`;
				default:
					return null;
			}
		}
		case 'var': {
			const { name, fallback } = token.value;
			if (name.from) return null;
			if (!fallback) return `var(${name.ident})`;
			const inner = cssOf(fallback);
			return inner === null ? null : `var(${name.ident},${inner})`;
		}
		case 'function': {
			const inner = cssOf(token.value.arguments);
			return inner === null ? null : `${token.value.name}(${inner})`;
		}
		case 'color': {
			const c = token.value;
			if (typeof c !== 'object' || c.type !== 'rgb') return null;
			return `rgb(${c.r} ${c.g} ${c.b} / ${round(c.alpha)})`;
		}
		case 'length':
			return `${round(token.value.value)}${token.value.unit}`;
		default:
			return null;
	}
}

const isMix = (token: TokenOrValue) =>
	token.type === 'function' && token.value.name.toLowerCase() === 'color-mix';

function hasMix(tokens: Tokens): boolean {
	return tokens.some(
		(token) =>
			isMix(token) ||
			(token.type === 'function' && hasMix(token.value.arguments)) ||
			(token.type === 'var' && token.value.fallback !== null && hasMix(token.value.fallback ?? [])),
	);
}

/** The tokens with every mix replaced by its fallback; null when one cannot be computed. */
function fallbackTokens(tokens: Tokens): Tokens | null {
	const out: Tokens = [];
	for (const token of tokens) {
		if (isMix(token)) {
			const text = tokenCss(token);
			const color = text === null ? null : colorChannelsOf(text, resolveByConvention);
			if (!color) return null;
			out.push(...tokensOf(channelsCss(color)));
		} else if (token.type === 'function' && hasMix(token.value.arguments)) {
			const args = fallbackTokens(token.value.arguments);
			if (!args) return null;
			out.push({ type: 'function', value: { name: token.value.name, arguments: args } });
		} else if (token.type === 'var' && token.value.fallback && hasMix(token.value.fallback)) {
			const fallback = fallbackTokens(token.value.fallback);
			if (!fallback) return null;
			out.push({ type: 'var', value: { ...token.value, fallback } });
		} else out.push(token);
	}
	return out;
}

/** A value's tokens without the white space around them. */
function trimmed(tokens: Tokens): Tokens {
	const blank = (t: TokenOrValue | undefined) =>
		t?.type === 'token' && t.value.type === 'white-space';
	let start = 0;
	let end = tokens.length;
	while (start < end && blank(tokens[start])) start++;
	while (end > start && blank(tokens[end - 1])) end--;
	return tokens.slice(start, end);
}

const custom = (name: string, value: string): Decl => ({
	property: 'custom',
	value: { name, value: tokensOf(value) },
});

const channelDecls = (name: string, color: Channels): Decl[] =>
	channelDeclarations(name, color).map(([prop, value]) => custom(prop, value));

/**
 * Tailwind's own variables (`--tw-ring-color`) are never mixed by name, and its palette
 * (`--color-red-500`) only through the theme's tokens: no channels for them.
 */
const wantsChannels = (name: string) => !name.startsWith('--tw-') && !name.startsWith('--color-');

/** What becomes of a rule's declarations. */
interface Written {
	declarations: Decl[];
	/** The declarations with a mix, set again under `@supports`. */
	moved: Decl[];
}

const keyOf = (type: string, loc: Location2) =>
	`${type}@${loc.source_index}:${loc.line}:${loc.column}`;

/**
 * Reads a sheet and works out what each rule it changes becomes. The rules are then replaced one
 * by one (`writeColorFallbacks`); untouched rules never pass through JavaScript, which matters:
 * lightningcss cannot take back some values it hands out (Tailwind's `calc(infinity * 1px)`).
 */
class Writer {
	/** Custom properties known to hold a color: the theme's tokens, and what this sheet sets. */
	readonly colors = new Set<string>();
	/** What each changed rule becomes, by its type and place in the source. */
	readonly replacements = new Map<string, Rule[]>();
	/** Declarations written so far: tells whether a rule changed. */
	written = 0;

	/** The value a custom property gets where `color-mix` is missing, and its channels. */
	customFallback(decl: CustomProperty): Decl[] | null {
		const value = trimmed(decl.value);
		const name = decl.name;
		if (hasMix(value)) {
			const tokens = fallbackTokens(value);
			if (!tokens) return null;
			const text = cssOf(value);
			const color = text === null ? null : colorChannelsOf(text, resolveByConvention);
			this.colors.add(name);
			return [
				{ property: 'custom', value: { name, value: tokens } },
				...(color && wantsChannels(name) ? channelDecls(name, color) : []),
			];
		}
		return null;
	}

	/** Channel declarations for a custom property set to a plain color or another variable. */
	aliasChannels(decl: CustomProperty): Decl[] {
		const name = decl.name;
		if (!wantsChannels(name)) return [];
		const value = trimmed(decl.value);
		const only = value.length === 1 ? value[0] : undefined;
		if (!only) return [];
		if (only.type === 'var') {
			const target = only.value.name.ident;
			const known =
				this.colors.has(name) ||
				isColorToken(name) ||
				this.colors.has(target) ||
				isColorToken(resolveByConvention(target)?.name ?? '');
			if (!known) return [];
		} else if (only.type !== 'color') return [];
		const text = cssOf(value);
		const color = text === null ? null : colorChannelsOf(text, resolveByConvention);
		if (!color) return [];
		this.colors.add(name);
		return channelDecls(name, color);
	}

	declarations(list: Decl[] | undefined): Written {
		const declarations: Decl[] = [];
		const moved: Decl[] = [];
		for (const decl of list ?? []) {
			if (decl.property === 'custom') {
				const fallback = this.customFallback(decl.value);
				if (fallback) {
					declarations.push(...fallback);
					moved.push(decl);
					this.written += fallback.length;
				} else {
					const channels = this.aliasChannels(decl.value);
					declarations.push(decl, ...channels);
					this.written += channels.length;
				}
			} else if (decl.property === 'unparsed' && hasMix(decl.value.value)) {
				const tokens = fallbackTokens(decl.value.value);
				if (tokens) {
					declarations.push({ ...decl, value: { ...decl.value, value: tokens } });
					moved.push(decl);
					this.written++;
				} else declarations.push(decl);
			} else declarations.push(decl);
		}
		return { declarations, moved };
	}

	/** The fallbacks of a rule under a `color-mix` `@supports`: what goes before the `@supports`. */
	fallbacksOf(list: Decl[] | undefined): Decl[] {
		const out: Decl[] = [];
		for (const decl of list ?? []) {
			if (decl.property === 'custom') out.push(...(this.customFallback(decl.value) ?? []));
			else if (decl.property === 'unparsed' && hasMix(decl.value.value)) {
				const tokens = fallbackTokens(decl.value.value);
				if (tokens) out.push({ ...decl, value: { ...decl.value, value: tokens } });
			}
		}
		return out;
	}

	rules(rules: Rule[]): Rule[] {
		const out: Rule[] = [];
		for (const rule of rules) out.push(...this.rule(rule));
		return out;
	}

	/** Notes what a changed rule becomes. */
	replace(type: string, loc: Location2, by: Rule[]): Rule[] {
		this.replacements.set(keyOf(type, loc), by);
		return by;
	}

	rule(rule: Rule): Rule[] {
		const before = this.written;
		switch (rule.type) {
			case 'style': {
				const normal = this.declarations(rule.value.declarations?.declarations);
				const important = this.declarations(rule.value.declarations?.importantDeclarations);
				const own = this.written > before;
				const out: Rule[] = [
					{
						type: 'style',
						value: {
							...rule.value,
							declarations: {
								declarations: normal.declarations,
								importantDeclarations: important.declarations,
							},
							rules: this.rules(rule.value.rules ?? []),
						},
					},
				];
				if (normal.moved.length + important.moved.length > 0) {
					const again: Rule = {
						type: 'style',
						value: {
							...rule.value,
							declarations: { declarations: normal.moved, importantDeclarations: important.moved },
							rules: [],
						},
					};
					out.push(this.supports([again], rule.value.loc));
				}
				return own ? this.replace(rule.type, rule.value.loc, out) : out;
			}
			case 'nested-declarations': {
				const written = this.declarations(rule.value.declarations.declarations);
				if (this.written === before) return [rule];
				const out: Rule[] = [
					{
						type: 'nested-declarations',
						value: { ...rule.value, declarations: { declarations: written.declarations } },
					},
				];
				if (written.moved.length > 0) {
					const again: Rule = {
						type: 'nested-declarations',
						value: { ...rule.value, declarations: { declarations: written.moved } },
					};
					out.push(this.supports([again], rule.value.loc));
				}
				return this.replace(rule.type, rule.value.loc, out);
			}
			case 'supports': {
				if (!JSON.stringify(rule.value.condition).includes('color-mix')) {
					return [{ ...rule, value: { ...rule.value, rules: this.rules(rule.value.rules) } }];
				}
				const fallbacks = this.underMixSupports(rule.value.rules);
				if (fallbacks.length === 0) return [rule];
				return this.replace(rule.type, rule.value.loc, [...fallbacks, rule]);
			}
			case 'media':
			case 'layer-block':
			case 'container':
			case 'scope':
			case 'starting-style':
			case 'moz-document':
				return [
					{ ...rule, value: { ...rule.value, rules: this.rules(rule.value.rules ?? []) } },
				] as Rule[];
			default:
				return [rule];
		}
	}

	/** For each rule under a `color-mix` `@supports`, the same selector with the fallbacks. */
	underMixSupports(rules: Rule[]): Rule[] {
		const out: Rule[] = [];
		for (const rule of rules) {
			if (rule.type === 'style') {
				const declarations = this.fallbacksOf(rule.value.declarations?.declarations);
				const important = this.fallbacksOf(rule.value.declarations?.importantDeclarations);
				if (declarations.length + important.length === 0) continue;
				this.written += declarations.length + important.length;
				out.push({
					type: 'style',
					value: {
						...rule.value,
						declarations: { declarations, importantDeclarations: important },
						rules: [],
					},
				});
			} else if (rule.type === 'nested-declarations') {
				const declarations = this.fallbacksOf(rule.value.declarations.declarations);
				if (declarations.length === 0) continue;
				this.written += declarations.length;
				out.push({
					type: 'nested-declarations',
					value: { ...rule.value, declarations: { declarations } },
				});
			}
		}
		return out;
	}

	supports(rules: Rule[], loc: Location2): Rule {
		return { type: 'supports', value: { condition: mixSupports(), loc, rules } };
	}
}

/**
 * Rules as lightningcss reads them back. It hands out a variable without a fallback or module as
 * `fallback: null` and `from: null` but refuses those nulls, so they are dropped. And it takes a
 * large whole number for an integer, which a length refuses: an infinite or huge one (Tailwind's
 * round corners, `calc(infinity * 1px)`) becomes ten million and a half, as good as infinite for
 * any length. Everything else is copied as it is (`NaN`, which a missing hue is, included).
 */
function readable<T>(value: T): T {
	if (Array.isArray(value)) return value.map(readable) as T;
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			if ((key === 'from' || key === 'fallback') && inner === null) continue;
			out[key] = readable(inner);
		}
		return out as T;
	}
	if (typeof value === 'number' && !Number.isNaN(value) && !(Math.abs(value) <= 1e18)) {
		return (Math.sign(value) * 10_000_000.5) as T;
	}
	return value;
}

/**
 * Whether a stylesheet may have anything for the writer (a mix, or a custom property that may be
 * a color): a cheap test that spares the parse for most component styles.
 */
const worthWriting = (css: string) => css.includes('color-mix') || /--[\w-]+\s*:/.test(css);

export interface ColorFallbackOptions {
	/** The browsers built for; nothing is written when all of them have `color-mix()`. */
	targets?: readonly string[];
	/** Minify the result for these targets (a stylesheet written straight to a package). */
	minify?: boolean;
	/** The file, for error messages. */
	filename?: string;
}

/** A stylesheet with the fallback of each `color-mix()` written in (see the rules above). */
export function writeColorFallbacks(css: string, options: ColorFallbackOptions = {}): string {
	const targets = options.targets ?? BROWSER_TARGETS;
	if (!needsColorMixFallback(targets) || !worthWriting(css)) return css;
	const filename = options.filename ?? 'style.css';
	const writer = new Writer();
	transform({
		filename,
		code: Buffer.from(css),
		visitor: {
			StyleSheet(sheet) {
				writer.rules(sheet.rules);
			},
		},
	});
	if (writer.replacements.size === 0) return css;
	// On the way out of a rule: its replacement already holds its written children.
	const swap = (rule: { type: string; value: { loc: Location2 } }) => {
		const key = keyOf(rule.type, rule.value.loc);
		const by = writer.replacements.get(key);
		if (!by) return undefined;
		writer.replacements.delete(key);
		return readable(by);
	};
	const result = transform({
		filename,
		code: Buffer.from(css),
		minify: options.minify ?? false,
		// Printed for the targets: without them lightningcss would drop a `vh` line before a `dvh` one.
		targets: lightningTargets(targets),
		visitor: {
			// One function for every rule: lightningcss 1.32 does not call a per-type `RuleExit`.
			RuleExit(rule) {
				if (
					rule.type === 'style' ||
					rule.type === 'nested-declarations' ||
					rule.type === 'supports'
				) {
					return swap(rule);
				}
				return undefined;
			},
		},
	});
	return result.code.toString();
}

/**
 * A Vite plugin that writes the fallbacks into the app's stylesheets once Tailwind has generated
 * them, before Vite turns them into modules. Component styles are left to the preprocessor.
 */
export function colorFallbackPlugin(targets: readonly string[] = BROWSER_TARGETS): Plugin {
	return {
		name: 'famos:color-fallback',
		transform(code, id) {
			if (!needsColorMixFallback(targets)) return undefined;
			const [path, query = ''] = id.split('?');
			if (!path?.endsWith('.css') || /(?:^|&)(?:raw|url|svelte)\b/.test(query)) return undefined;
			if (!worthWriting(code)) return undefined;
			return { code: writeColorFallbacks(code, { targets, filename: path }), map: null };
		},
	};
}
