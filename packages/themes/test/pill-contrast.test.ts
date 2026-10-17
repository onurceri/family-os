import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor, type Rgba, validateThemePack } from '../src/index.ts';
import { listThemeDirsSync, readThemeDirSync } from '../src/node.ts';

/**
 * A status pill puts a 15 % tint of the state colour behind text
 * that is the state colour mixed toward `ink` (65/35 for attention, now and info; 50/50 for heat
 * and sun), mixed in oklab like CSS `color-mix(in oklab, ...)` in packages/ui/src/famos/Pill.svelte.
 * This computes those mixes for every bundled pack, day and night, so a new pack cannot ship a
 * palette whose pills fall under 4.5:1.
 */
const root = join(import.meta.dirname, '../../..');

const MIXES = [
	{ state: 'attention', share: 0.65 },
	{ state: 'now', share: 0.65 },
	{ state: 'info', share: 0.65 },
	{ state: 'heat', share: 0.5 },
	{ state: 'sun', share: 0.5 },
] as const;
const TINT = 0.15;
const MIN = 4.5;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

type Lab = [number, number, number];

function toOklab(c: Rgba): Lab {
	const r = toLinear(c.r / 255);
	const g = toLinear(c.g / 255);
	const b = toLinear(c.b / 255);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function fromOklab([L, a, b]: Lab): Rgba {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	] as const;
	const [r, g, bl] = lin.map((v) => Math.min(255, Math.max(0, Math.round(toSrgb(v) * 255))));
	return { r: r as number, g: g as number, b: bl as number, a: 1 };
}

/** `color-mix(in oklab, from share%, to)` of two opaque colors. */
function mix(from: Rgba, share: number, to: Rgba): Rgba {
	const a = toOklab(from);
	const b = toOklab(to);
	return fromOklab([
		a[0] * share + b[0] * (1 - share),
		a[1] * share + b[1] * (1 - share),
		a[2] * share + b[2] * (1 - share),
	]);
}

/** `color-mix(in oklab, color 15%, transparent)` painted over an opaque backdrop. */
function tintOver(color: Rgba, backdrop: Rgba): Rgba {
	const over = (top: number, bottom: number) => Math.round(top * TINT + bottom * (1 - TINT));
	return {
		r: over(color.r, backdrop.r),
		g: over(color.g, backdrop.g),
		b: over(color.b, backdrop.b),
		a: 1,
	};
}

const color = (text: string): Rgba => {
	const parsed = parseColor(text);
	if (!parsed) throw new Error(`not a color: ${text}`);
	return parsed;
};

describe('status pills keep 4.5:1 in every bundled pack', () => {
	const ids = listThemeDirsSync(join(root, 'themes')).map((dir) => dir.split('/').pop() as string);

	it('finds the six bundled packs', () => {
		expect(ids.sort()).toEqual(['coast', 'ev-isigi', 'forest', 'high-contrast', 'paper', 'plum']);
	});

	for (const id of ['coast', 'ev-isigi', 'forest', 'high-contrast', 'paper', 'plum']) {
		for (const mode of ['day', 'night'] as const) {
			it(`${id} ${mode}`, () => {
				const raw = readThemeDirSync(join(root, 'themes', id));
				const fallback = validateThemePack(readThemeDirSync(join(root, 'themes', 'ev-isigi')));
				if (!fallback.ok) throw new Error('ev-isigi is invalid');
				const result = validateThemePack(raw, { fallback: fallback.pack.tokens });
				if (!result.ok) throw new Error(`${id}: ${result.errors.join('; ')}`);
				const tokens = result.pack.tokens[mode];
				const surface = color(tokens.surface);
				const ink = color(tokens.ink);
				const failures: string[] = [];
				for (const { state, share } of MIXES) {
					const base = color(tokens[state]);
					const text = mix(base, share, ink);
					const ratio = contrastRatio(text, tintOver(base, surface));
					if (ratio < MIN) failures.push(`${state} ${ratio.toFixed(2)}`);
				}
				expect(failures, `${id} ${mode} pills under ${MIN}:1`).toEqual([]);
			});
		}
	}

	it('the check fails a palette whose state colour is too close to its surface', () => {
		const surface = color('#ffffff');
		const ink = color('#ffffff');
		const base = color('#ffee00');
		const ratio = contrastRatio(mix(base, 0.5, ink), tintOver(base, surface));
		expect(ratio).toBeLessThan(MIN);
	});
});
