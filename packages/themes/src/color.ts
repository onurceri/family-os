/**
 * Colors for theme packs: parsing of the notations a pack may use (hex, rgb(),
 * oklch()), the canonical form that is written to the stylesheet, and WCAG contrast. Everything
 * the server sends to browsers is built from these parsed numbers, never from the pack's text.
 */

/** sRGB channels 0 to 255 (fractions allowed) and alpha 0 to 1. */
export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function num(text: string): number | null {
	if (!new RegExp(`^${NUMBER}$`, 'i').test(text)) return null;
	const v = Number(text);
	return Number.isFinite(v) ? v : null;
}

/** A number or a percentage; a percentage is scaled to `percentOf`. */
function numOrPercent(text: string, percentOf: number): number | null {
	if (text.endsWith('%')) {
		const v = num(text.slice(0, -1));
		return v === null ? null : (v / 100) * percentOf;
	}
	return num(text);
}

function parseHex(text: string): Rgba | null {
	const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
	if (!m) return null;
	let hex = m[1] as string;
	if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
	const byte = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
	return { r: byte(0), g: byte(2), b: byte(4), a: hex.length === 8 ? byte(6) / 255 : 1 };
}

/** The arguments of `name( … )` split into channels and an optional alpha, or null. */
function functionArgs(
	text: string,
	names: readonly string[],
): { channels: string[]; alpha: string | null } | null {
	const m = /^([a-z]+)\(\s*([^()]*?)\s*\)$/i.exec(text);
	if (!m || !names.includes((m[1] as string).toLowerCase())) return null;
	const body = m[2] as string;
	let channels: string[];
	let alpha: string | null = null;
	if (body.includes(',')) {
		// Legacy comma syntax: rgb(1, 2, 3) or rgba(1, 2, 3, 0.5).
		const parts = body.split(',').map((p) => p.trim());
		if (parts.length !== 3 && parts.length !== 4) return null;
		channels = parts.slice(0, 3);
		alpha = parts[3] ?? null;
	} else {
		const [main, a, ...rest] = body.split('/').map((p) => p.trim());
		if (rest.length > 0 || !main) return null;
		channels = main.split(/\s+/);
		alpha = a ?? null;
		if (a !== undefined && a === '') return null;
	}
	if (channels.length !== 3) return null;
	return { channels, alpha };
}

function parseAlpha(text: string | null): number | null {
	if (text === null) return 1;
	const v = numOrPercent(text, 1);
	return v === null ? null : clamp(v, 0, 1);
}

function parseRgb(text: string): Rgba | null {
	const args = functionArgs(text, ['rgb', 'rgba']);
	if (!args) return null;
	const channels = args.channels.map((c) => numOrPercent(c, 255));
	const a = parseAlpha(args.alpha);
	if (a === null || channels.some((c) => c === null)) return null;
	const [r, g, b] = channels.map((c) => clamp(c as number, 0, 255));
	return { r: r as number, g: g as number, b: b as number, a };
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** OKLCH to sRGB (Björn Ottosson's matrices); out-of-gamut colors are clamped per channel. */
function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
	const h = (hDeg * Math.PI) / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
	];
	return lin.map((v) => clamp(fromLinear(clamp(v, 0, 1)), 0, 1) * 255) as [number, number, number];
}

function parseOklch(text: string): Rgba | null {
	const args = functionArgs(text, ['oklch']);
	if (!args) return null;
	const [ls, cs, hs] = args.channels as [string, string, string];
	const l = numOrPercent(ls, 1);
	const c = numOrPercent(cs, 0.4);
	const hue = hs.toLowerCase().endsWith('deg') ? num(hs.slice(0, -3)) : num(hs);
	const a = parseAlpha(args.alpha);
	if (l === null || c === null || hue === null || a === null) return null;
	const [r, g, b] = oklchToRgb(clamp(l, 0, 1), clamp(c, 0, 0.5), ((hue % 360) + 360) % 360);
	return { r, g, b, a };
}

/** Parses a color written as hex, `rgb()` or `oklch()`; null when it is none of those. */
export function parseColor(text: string): Rgba | null {
	const value = text.trim();
	if (value.length === 0 || value.length > 80) return null;
	if (value.startsWith('#')) return parseHex(value);
	const lower = value.toLowerCase();
	if (lower.startsWith('rgb')) return parseRgb(value);
	if (lower.startsWith('oklch')) return parseOklch(value);
	return null;
}

const hex2 = (v: number) =>
	Math.round(clamp(v, 0, 255))
		.toString(16)
		.padStart(2, '0');

/** The canonical CSS for a color: `#rrggbb`, or `rgb(r g b / a)` when it is not opaque. */
export function serializeColor(color: Rgba): string {
	if (color.a >= 1) return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
	const a = Number(color.a.toFixed(3));
	return `rgb(${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)} / ${a})`;
}

/**
 * A color's channels as the stylesheet writes them next to the color (`--ink-r` …), for browsers
 * without `color-mix()`: the same rounding as `serializeColor`, so both name one color.
 */
export function colorChannels(color: Rgba): Rgba {
	const channel = (v: number) => Math.round(clamp(v, 0, 255));
	return {
		r: channel(color.r),
		g: channel(color.g),
		b: channel(color.b),
		a: color.a >= 1 ? 1 : Number(clamp(color.a, 0, 1).toFixed(3)),
	};
}

/** WCAG relative luminance of an sRGB color. */
export function luminance(color: Rgba): number {
	return (
		0.2126 * toLinear(Math.round(color.r) / 255) +
		0.7152 * toLinear(Math.round(color.g) / 255) +
		0.0722 * toLinear(Math.round(color.b) / 255)
	);
}

/** WCAG contrast ratio between two opaque colors, 1 to 21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
