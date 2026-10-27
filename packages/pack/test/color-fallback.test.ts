import { describe, expect, it } from 'vitest';
import {
	colorChannelsOf,
	colorMixFallback,
	type ResolveChannels,
	resolveByConvention,
} from '../src/color-fallback.ts';

type Rgba = [number, number, number, number];

/** The colors behind the variables, as a browser would have them. */
const VARS: Record<string, Rgba> = {
	'--ink': [29, 28, 26, 1],
	'--surface': [251, 250, 247, 1],
	'--sun': [217, 169, 47, 1],
	'--info': [61, 110, 142, 1],
	'--board': [236, 223, 198, 1],
	'--board-grain': [120, 82, 36, 0.16],
	'--note-1': [253, 238, 169, 1],
	'--note-ink': [42, 36, 23, 1],
	'--m': [200, 40, 120, 1],
	'--lamp': [43, 36, 27, 0.9],
};

/**
 * CSS Color 5 `color-mix()` in sRGB, written out on its own: percentages normalized, a sum below
 * 100 % scaling alpha, channels premultiplied by alpha.
 */
function reference(one: Rgba, p1: number | null, two: Rgba, p2: number | null): Rgba {
	let [a, b] = [p1, p2];
	if (a === null && b === null) [a, b] = [50, 50];
	else if (a === null) a = 100 - (b as number);
	else if (b === null) b = 100 - a;
	const sum = (a as number) + (b as number);
	const [w1, w2] = [(a as number) / sum, (b as number) / sum];
	const alpha = one[3] * w1 + two[3] * w2;
	const channel = (i: number) =>
		alpha === 0 ? 0 : ((one[i] as number) * one[3] * w1 + (two[i] as number) * two[3] * w2) / alpha;
	return [channel(0), channel(1), channel(2), alpha * (Math.min(sum, 100) / 100)];
}

/** Evaluates a fallback `rgb(…)` with the variables above: what an older browser computes. */
function evaluate(css: string): Rgba {
	const value = (name: string): number | undefined => {
		const match = /^(--[\w-]+)-([rgba])$/.exec(name);
		if (!match) return undefined;
		const color = VARS[match[1] as string];
		return color?.['rgba'.indexOf(match[2] as string)];
	};
	let expr = css;
	// Innermost `var()` first, so a fallback that is itself a `var()` resolves before its holder.
	for (let i = 0; i < 20 && expr.includes('var('); i++) {
		expr = expr.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (_, name: string, fb?: string) => {
			const found = value(name);
			if (found !== undefined) return String(found);
			if (fb === undefined) throw new Error(`no value for ${name}`);
			return fb;
		});
	}
	const body = /^rgb\((.*)\)$/.exec(expr)?.[1] ?? '';
	// Top-level words: the three channels, the slash and the alpha.
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of body) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ' ' && depth === 0) {
			parts.push(current);
			current = '';
		} else current += ch;
	}
	parts.push(current);
	const [r, g, b, slash, alpha] = parts;
	if (slash !== '/' || alpha === undefined) throw new Error(`not rgb(r g b / a): ${css}`);
	const run = (text: string) =>
		Number(Function(`return ${text.replaceAll('calc(', '(').replaceAll('max(', 'Math.max(')}`)());
	return [run(r as string), run(g as string), run(b as string), run(alpha)];
}

function expectClose(actual: Rgba, expected: Rgba) {
	actual.forEach((v, i) => {
		expect(v).toBeCloseTo(expected[i] as number, 3);
	});
}

const mixOf = (text: string) => colorMixFallback(text) as string;

describe('colorMixFallback', () => {
	it('mixes with transparent by scaling alpha alone', () => {
		expect(mixOf('color-mix(in srgb, var(--ink) 10%, transparent)')).toBe(
			'rgb(var(--ink-r) var(--ink-g) var(--ink-b) / 0.1)',
		);
		expect(mixOf('color-mix(in oklab, transparent, var(--board-grain) 55%)')).toBe(
			'rgb(var(--board-grain-r) var(--board-grain-g) var(--board-grain-b) / calc(var(--board-grain-a) * 0.55))',
		);
	});

	it('mixes two opaque colors', () => {
		const css = mixOf('color-mix(in srgb, var(--surface) 94%, var(--ink))');
		expect(css).not.toContain('max(');
		expectClose(
			evaluate(css),
			reference(VARS['--surface'] as Rgba, 94, VARS['--ink'] as Rgba, null),
		);
	});

	it('premultiplies colors with alpha', () => {
		const css = mixOf('color-mix(in srgb, var(--board-grain) 55%, var(--board))');
		expectClose(
			evaluate(css),
			reference(VARS['--board-grain'] as Rgba, 55, VARS['--board'] as Rgba, null),
		);
		const two = mixOf('color-mix(in srgb, var(--m) 40%, var(--lamp))');
		expectClose(evaluate(two), reference(VARS['--m'] as Rgba, 40, VARS['--lamp'] as Rgba, null));
	});

	it('normalizes unequal and omitted percentages', () => {
		const sun = VARS['--sun'] as Rgba;
		const ink = VARS['--ink'] as Rgba;
		const cases: [string, number | null, number | null][] = [
			['color-mix(in srgb, var(--sun), var(--ink))', null, null],
			['color-mix(in srgb, var(--sun), var(--ink) 25%)', null, 25],
			['color-mix(in srgb, 30% var(--sun), var(--ink) 30%)', 30, 30],
			['color-mix(in srgb, var(--sun) 80%, var(--ink) 40%)', 80, 40],
		];
		for (const [text, p1, p2] of cases) {
			expectClose(evaluate(mixOf(text)), reference(sun, p1, ink, p2));
		}
		expect(colorMixFallback('color-mix(in srgb, var(--sun) 0%, var(--ink) 0%)')).toBeNull();
	});

	it('computes nested mixes', () => {
		const css = mixOf(
			'color-mix(in srgb, color-mix(in srgb, var(--note-1) 94%, var(--note-ink)) 84%, var(--lamp))',
		);
		const inner = reference(VARS['--note-1'] as Rgba, 94, VARS['--note-ink'] as Rgba, null);
		expectClose(evaluate(css), reference(inner, 84, VARS['--lamp'] as Rgba, null));
	});

	it('writes an oklab mix with sRGB math', () => {
		expect(mixOf('color-mix(in oklab, var(--m) 16%, var(--surface))')).toBe(
			mixOf('color-mix(in srgb, var(--m) 16%, var(--surface))'),
		);
	});

	it('replaces every mix of a longer value and keeps the rest', () => {
		expect(
			colorMixFallback(
				'0 1px 2px color-mix(in srgb, var(--ink) 10%, transparent), inset 0 0 0 1px var(--line)',
			),
		).toBe(
			'0 1px 2px rgb(var(--ink-r) var(--ink-g) var(--ink-b) / 0.1), inset 0 0 0 1px var(--line)',
		);
		expect(colorMixFallback('var(--ink)')).toBeNull();
	});

	it('resolves aliases: Tailwind colors, fallbacks and literal colors', () => {
		expect(mixOf('color-mix(in oklab, var(--color-ink) 10%, transparent)')).toBe(
			'rgb(var(--ink-r) var(--ink-g) var(--ink-b) / 0.1)',
		);
		const lamp = mixOf('color-mix(in srgb, var(--note-1) 84%, var(--nope, var(--board)))');
		expect(lamp).toContain('var(--nope-r,var(--board-r))');
		expectClose(
			evaluate(lamp),
			reference(VARS['--note-1'] as Rgba, 84, VARS['--board'] as Rgba, null),
		);
		expectClose(
			evaluate(mixOf('color-mix(in srgb, #ff0000 25%, rgb(0 0 255 / 0.5))')),
			reference([255, 0, 0, 1], 25, [0, 0, 255, 0.5], null),
		);
	});

	it('gives up on what it cannot compute', () => {
		const strict: ResolveChannels = (name) =>
			name === '--ink' ? (resolveByConvention(name) ?? null) : null;
		expect(
			colorMixFallback('color-mix(in srgb, var(--mystery) 10%, var(--ink))', strict),
		).toBeNull();
		expect(colorMixFallback('color-mix(in srgb, currentColor 10%, transparent)')).toBeNull();
		expect(colorMixFallback('color-mix(in srgb, red 10%, transparent)')).toBeNull();
		expect(colorMixFallback('color-mix(in hsl, var(--ink) 10%, transparent)')).toBeNull();
		expect(colorMixFallback('color-mix(in oklch longer hue, var(--ink), var(--sun))')).toBeNull();
		expect(colorMixFallback('color-mix(in srgb, var(--ink) calc(5% * 2), transparent)')).toBeNull();
	});

	it('reads a single color for its channels', () => {
		expect(colorChannelsOf('var(--board)')).toEqual({
			r: 'var(--board-r)',
			g: 'var(--board-g)',
			b: 'var(--board-b)',
			a: '1',
		});
		expect(colorChannelsOf('#ffffff80')?.a).toBe('0.502');
		expect(colorChannelsOf('var(--ink) 10%')).toBeNull();
	});
});
