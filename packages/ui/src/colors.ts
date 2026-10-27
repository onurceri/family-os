/**
 * Colors as channels, for browsers without `color-mix()` (before Chrome 111, Safari 16.2 and
 * Firefox 113). Every color a mix may use is also set as four custom properties, `--x-r`,
 * `--x-g`, `--x-b` (0 to 255) and `--x-a` (0 to 1); a mix is then written as
 * `rgb(calc(…) calc(…) calc(…) / calc(…))` over them, which those browsers do understand.
 *
 * The build writes such a line before every `color-mix()` of a stylesheet (`@famos/pack`), and
 * colors set from script use `colorVars`. Once no supported browser lacks `color-mix()`, this
 * module and everything that uses it can go.
 */

/**
 * A color as four CSS expressions, each valid inside `calc()`: plain numbers, `var()`s or
 * arithmetic over them. A channel set holding the literal alpha `'1'` is known to be opaque.
 */
export interface Channels {
	r: string;
	g: string;
	b: string;
	a: string;
}

export const TRANSPARENT: Channels = { r: '0', g: '0', b: '0', a: '0' };

const CHANNELS = ['r', 'g', 'b'] as const;

const isNumber = (expr: string) => /^-?\d+(?:\.\d+)?$/.test(expr);

/** A number as CSS, without float noise (`0.30000000000000004` → `0.3`). */
const num = (value: number, digits = 6) => String(Number(value.toFixed(digits)));

/** An expression ready to be a factor: a bare number or `var()` as it is, anything else in brackets. */
const factor = (expr: string) => (expr.includes(' ') ? `(${expr})` : expr);

/** `expr × k`, folded where it can be. */
function scale(expr: string, k: number): string {
	if (k === 0 || expr === '0') return '0';
	if (k === 1) return expr;
	if (isNumber(expr)) return num(Number(expr) * k);
	return `${factor(expr)} * ${num(k)}`;
}

/** `x × y` of two expressions. */
function product(x: string, y: string): string {
	if (x === '0' || y === '0') return '0';
	if (x === '1') return y;
	if (y === '1') return x;
	if (isNumber(x) && isNumber(y)) return num(Number(x) * Number(y));
	return `${factor(x)} * ${factor(y)}`;
}

function sum(x: string, y: string): string {
	if (x === '0') return y;
	if (y === '0') return x;
	if (isNumber(x) && isNumber(y)) return num(Number(x) + Number(y));
	return `${x} + ${y}`;
}

/**
 * The channels of a custom property (`--paper`), or of a `var()` with a fallback color when a
 * channel set is given for it. `opaque` states that the color never has transparency (a theme
 * token a pack must give as an opaque color), which keeps the written math short.
 */
export function varChannels(name: string, fallback?: Channels, opaque = false): Channels {
	const ref = (channel: string, fb: string | undefined) =>
		`var(${name}-${channel}${fb === undefined ? '' : `,${fb}`})`;
	return {
		r: ref('r', fallback?.r),
		g: ref('g', fallback?.g),
		b: ref('b', fallback?.b),
		a: opaque && (fallback === undefined || fallback.a === '1') ? '1' : ref('a', fallback?.a),
	};
}

/** The channels of a literal color: sRGB 0 to 255, alpha 0 to 1. */
export function literalChannels(r: number, g: number, b: number, a = 1): Channels {
	return { r: num(r, 3), g: num(g, 3), b: num(b, 3), a: num(a, 4) };
}

/**
 * `color-mix(in srgb, one p1, two p2)` as channels (CSS Color 5): omitted percentages complete
 * each other to 100 % (both omitted: 50 % each), shares that add up to less than 100 % make the
 * result that much more transparent, and the channels are mixed premultiplied by alpha. Null when
 * the percentages are invalid (negative, over 100, or both zero).
 */
export function mixChannels(
	one: Channels,
	p1: number | null,
	two: Channels,
	p2: number | null,
): Channels | null {
	let first = p1;
	let second = p2;
	if (first === null && second === null) first = second = 50;
	else if (first === null) first = 100 - (second as number);
	else if (second === null) second = 100 - first;
	const [s1, s2] = [first as number, second as number];
	if (s1 < 0 || s2 < 0 || s1 > 100 || s2 > 100 || s1 + s2 === 0) return null;
	const total = s1 + s2;
	const w1 = s1 / total;
	const w2 = s2 / total;
	const keep = Math.min(total, 100) / 100;

	if (one.a === '0' && two.a === '0') return TRANSPARENT;
	// Mixing with a fully transparent color only scales the other one's alpha.
	if (two.a === '0' || w2 === 0) return { ...one, a: scale(one.a, w1 * keep) };
	if (one.a === '0' || w1 === 0) return { ...two, a: scale(two.a, w2 * keep) };
	const out = { a: '' } as Channels;
	if (one.a === '1' && two.a === '1') {
		for (const c of CHANNELS) out[c] = sum(scale(one[c], w1), scale(two[c], w2));
		out.a = num(keep);
		return out;
	}
	// Premultiplied: each channel weighs by its color's alpha; a sum of alphas of 0 (both colors
	// transparent through their variables) gives 0 over a tiny number, not a division by zero.
	const alpha = sum(scale(one.a, w1), scale(two.a, w2));
	for (const c of CHANNELS) {
		const weighted = sum(scale(product(one[c], one.a), w1), scale(product(two[c], two.a), w2));
		out[c] = `${factor(weighted)} / max(${alpha}, 0.000001)`;
	}
	out.a = scale(alpha, keep);
	return out;
}

/** One channel as a value of `rgb()`: a plain number or `var()` as is, the rest in `calc()`. */
export const channelCss = (expr: string) => (expr.includes(' ') ? `calc(${expr})` : expr);

/** The color as CSS an older browser understands: `rgb(r g b / a)`. */
export function channelsCss(color: Channels): string {
	const [r, g, b, a] = [color.r, color.g, color.b, color.a].map(channelCss);
	return `rgb(${r} ${g} ${b} / ${a})`;
}

/** `--x-r: …; --x-g: …; --x-b: …; --x-a: …` for a color. */
export function channelDeclarations(name: string, color: Channels): [string, string][] {
	return [
		[`${name}-r`, channelCss(color.r)],
		[`${name}-g`, channelCss(color.g)],
		[`${name}-b`, channelCss(color.b)],
		[`${name}-a`, channelCss(color.a)],
	];
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(([^()]*)\)$/i;

/** The channels of `#rgb`, `#rrggbb` (with or without alpha) or `rgb()`, or null. */
export function parseColorChannels(text: string): Channels | null {
	const value = text.trim();
	const hex = HEX.exec(value)?.[1];
	if (hex) {
		const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
		const byte = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
		return literalChannels(byte(0), byte(2), byte(4), full.length === 8 ? byte(6) / 255 : 1);
	}
	const body = RGB.exec(value)?.[1];
	if (body === undefined) return null;
	const parts = body.includes(',')
		? body.split(',').map((p) => p.trim())
		: body
				.split('/')
				.flatMap((p, i) => (i === 0 ? p.trim().split(/\s+/) : [p.trim()]))
				.filter(Boolean);
	if (parts.length !== 3 && parts.length !== 4) return null;
	const read = (p: string, scaleTo: number) =>
		p.endsWith('%') ? (Number(p.slice(0, -1)) / 100) * scaleTo : Number(p);
	const [r, g, b] = parts.slice(0, 3).map((p) => read(p, 255)) as [number, number, number];
	const a = parts[3] === undefined ? 1 : read(parts[3], 1);
	if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null;
	return literalChannels(r, g, b, a);
}

/** The channels of `var(--x)` or `var(--x, <color>)`, or null. */
function varColorChannels(text: string): Channels | null {
	const match = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+?)\s*)?\)$/.exec(text.trim());
	const name = match?.[1];
	if (!name) return null;
	const fallback = match[2];
	if (fallback === undefined) return varChannels(name);
	const inner = colorChannels(fallback);
	return inner ? varChannels(name, inner) : null;
}

/** The channels of a color given as hex, `rgb()` or `var(--x)`; null for anything else. */
export function colorChannels(text: string): Channels | null {
	return parseColorChannels(text) ?? varColorChannels(text);
}

/**
 * Inline style that sets a color variable for a stylesheet to use: `--name` and its channels, so
 * a `color-mix()` over it still works where the browser has no `color-mix()`. Use it for any
 * color set from script that a stylesheet mixes (`style={colorVars('m', member.color)}`).
 * Undefined for no color; a value it cannot read is set without channels.
 */
export function colorVars(name: string, color: string | null | undefined): string | undefined {
	if (!color) return undefined;
	const prop = `--${name}`;
	const channels = colorChannels(color);
	const lines = [[prop, color] as [string, string]];
	if (channels) lines.push(...channelDeclarations(prop, channels));
	return lines.map(([p, v]) => `${p}: ${v}`).join('; ');
}
