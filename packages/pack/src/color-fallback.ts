import { MODE_TOKENS } from '@famos/themes';
import {
	type Channels,
	channelsCss,
	mixChannels,
	parseColorChannels,
	TRANSPARENT,
	varChannels,
} from '@famos/ui/colors';

/**
 * `color-mix()` for browsers without it: the same color computed from channel variables
 * (`@famos/ui/colors`). Mixes `in srgb` come out exact. Mixes `in oklab` are computed in sRGB
 * too: an older browser's `calc()` has no cube root (`pow()` came after `color-mix()`), so OKLab
 * cannot be reached. Mixing with `transparent` only scales alpha and is exact in any space; for
 * two colors the sRGB result is slightly darker in the middle of a strong hue change, and closest
 * for the light tints and shades the app mixes.
 */

/** Where a variable's channels are: the custom property that has them, and whether it is opaque. */
export interface ChannelSource {
	name: string;
	opaque: boolean;
}

/** Finds the channel source of a custom property, or null when it has none. */
export type ResolveChannels = (name: string) => ChannelSource | null;

const colorTokens = Object.entries(MODE_TOKENS).filter(([, info]) => info.kind === 'color');
const COLOR_TOKENS = new Set(colorTokens.map(([name]) => `--${name}`));
const OPAQUE_TOKENS = new Set(
	colorTokens.filter(([, info]) => !('alpha' in info && info.alpha)).map(([name]) => `--${name}`),
);

/** Whether a custom property is one of the theme's color tokens. */
export const isColorToken = (name: string) => COLOR_TOKENS.has(name);

/** Tailwind's theme colors (`--color-ink`) are the theme's tokens (`--ink`). */
const tokenOf = (name: string) =>
	name.startsWith('--color-') && COLOR_TOKENS.has(`--${name.slice(8)}`)
		? `--${name.slice(8)}`
		: name;

/**
 * The build's rule: every custom property a mix uses carries channels under its own name (theme
 * tokens, aliases the stylesheets declare, `colorVars` from script). The guard test holds the
 * source to it; theme tokens other than the transparent ones are known to be opaque.
 */
export const resolveByConvention: ResolveChannels = (name) => {
	const source = tokenOf(name);
	return { name: source, opaque: OPAQUE_TOKENS.has(source) };
};

const SPACES = new Set(['srgb', 'oklab']);
const IDENT = /-?[a-zA-Z_][\w-]*|--[\w-]+/y;
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iy;

/** A reader over a CSS value: just enough of the syntax for the colors a mix may hold. */
class Reader {
	at = 0;
	readonly text: string;
	readonly resolve: ResolveChannels;
	constructor(text: string, resolve: ResolveChannels) {
		this.text = text;
		this.resolve = resolve;
	}

	space(): void {
		while (/\s/.test(this.text[this.at] ?? '')) this.at++;
	}

	take(literal: string): boolean {
		if (this.text.slice(this.at, this.at + literal.length).toLowerCase() !== literal) return false;
		this.at += literal.length;
		return true;
	}

	match(pattern: RegExp): string | null {
		pattern.lastIndex = this.at;
		const found = pattern.exec(this.text)?.[0];
		if (found === undefined) return null;
		this.at += found.length;
		return found;
	}

	/** From an opening bracket just read to its closing one, the text inside. */
	balanced(): string | null {
		let depth = 1;
		const start = this.at;
		while (this.at < this.text.length) {
			const ch = this.text[this.at++];
			if (ch === '(') depth++;
			else if (ch === ')' && --depth === 0) return this.text.slice(start, this.at - 1);
		}
		return null;
	}

	percentage(): number | null {
		const start = this.at;
		const value = this.match(NUMBER);
		if (value !== null && this.take('%')) return Number(value);
		this.at = start;
		return null;
	}

	color(): Channels | null {
		this.space();
		if (this.take('var(')) return this.variable();
		if (this.take('color-mix(')) return this.mix();
		if (this.text[this.at] === '#') {
			this.at++;
			const hex = this.match(/[0-9a-f]+/iy);
			return hex ? parseColorChannels(`#${hex}`) : null;
		}
		const name = this.match(IDENT)?.toLowerCase();
		if (name === 'transparent') return TRANSPARENT;
		if ((name === 'rgb' || name === 'rgba') && this.take('(')) {
			const body = this.balanced();
			return body === null ? null : parseColorChannels(`rgb(${body})`);
		}
		return null;
	}

	/** After `var(`: the variable's channels, with its fallback color's when it has one. */
	variable(): Channels | null {
		this.space();
		const name = this.match(IDENT);
		if (!name?.startsWith('--')) return null;
		const source = this.resolve(name);
		if (!source) return null;
		this.space();
		let fallback: Channels | undefined;
		if (this.take(',')) {
			const inner = this.color();
			if (!inner) return null;
			fallback = inner;
			this.space();
		}
		if (!this.take(')')) return null;
		return varChannels(source.name, fallback, source.opaque);
	}

	operand(): { color: Channels; share: number | null } | null {
		this.space();
		let share = this.percentage();
		const color = this.color();
		if (!color) return null;
		this.space();
		if (share === null) share = this.percentage();
		this.space();
		return { color, share };
	}

	/** After `color-mix(`: the mix's channels, or null when it is not one this can compute. */
	mix(): Channels | null {
		this.space();
		if (!this.take('in')) return null;
		this.space();
		const space = this.match(IDENT)?.toLowerCase();
		if (!space || !SPACES.has(space)) return null;
		this.space();
		if (!this.take(',')) return null;
		const one = this.operand();
		if (!one || !this.take(',')) return null;
		const two = this.operand();
		if (!two || !this.take(')')) return null;
		return mixChannels(one.color, one.share, two.color, two.share);
	}
}

/** The channels of one color: a `color-mix()`, a `var()`, `transparent`, hex or `rgb()`. */
export function colorChannelsOf(
	text: string,
	resolve: ResolveChannels = resolveByConvention,
): Channels | null {
	const reader = new Reader(text, resolve);
	const color = reader.color();
	reader.space();
	return color && reader.at === text.length ? color : null;
}

/** Where each `color-mix(` of a value starts (not a part of a longer name). */
function mixStarts(value: string): number[] {
	const starts: number[] = [];
	const lower = value.toLowerCase();
	let at = lower.indexOf('color-mix(');
	while (at !== -1) {
		if (!/[\w-]/.test(lower[at - 1] ?? '')) starts.push(at);
		at = lower.indexOf('color-mix(', at + 1);
	}
	return starts;
}

/**
 * A CSS value with each `color-mix()` in it replaced by the `rgb()` an older browser computes to
 * the same color, from the channel variables. Null when the value has no mix, or has one this
 * cannot compute (a variable without channels, `currentColor`, a named color, a polar or other
 * space): then nothing is written and the mix stays as it is.
 */
export function colorMixFallback(
	value: string,
	resolve: ResolveChannels = resolveByConvention,
): string | null {
	let out = '';
	let done = 0;
	for (const start of mixStarts(value)) {
		if (start < done) continue;
		const reader = new Reader(value, resolve);
		reader.at = start + 'color-mix('.length;
		const color = reader.mix();
		if (!color) return null;
		out += value.slice(done, start) + channelsCss(color);
		done = reader.at;
	}
	return done === 0 ? null : out + value.slice(done);
}
