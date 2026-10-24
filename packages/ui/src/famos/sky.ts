/**
 * The weather sky's picture (`WeatherSky.svelte`), kept pure so it can be tested without a DOM:
 * which sky a WMO weather code draws, and the colour mixes it is painted with. The mixes are the
 * single source for both the component (as CSS `color-mix(in srgb, …)`) and the contrast test
 * (scripts/sky-contrast.test.ts), which checks text on the sky in every bundled theme pack.
 */

import { weatherKind } from '@famos/time';

export type SkyKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

export interface SkyCondition {
	kind: SkyKind;
	/** The sun is down (Open-Meteo's `is_day` is 0). */
	night: boolean;
}

export const SKY_KINDS: readonly SkyKind[] = [
	'clear',
	'partly',
	'cloudy',
	'fog',
	'drizzle',
	'rain',
	'snow',
	'storm',
];

/**
 * The sky for a WMO weather interpretation code (Open-Meteo) and whether it is day. Codes it
 * does not know draw an overcast sky: atmosphere, never a wrong promise of sun.
 */
export function skyCondition(code: number, isDay: boolean): SkyCondition {
	const kind = weatherKind(code);
	return { kind: kind === 'cloud' ? 'cloudy' : kind, night: !isDay };
}

/**
 * A theme token the sky mixes. `backdrop` (black in every pack) deepens a sky in both light and
 * dark themes; `sky-cloud` (clouds, fog, may be transparent) and `sky-flake` (snow) are the sky's
 * own tokens, light in both.
 */
export type SkyToken =
	| 'info'
	| 'ink-soft'
	| 'sun'
	| 'backdrop'
	| 'surface'
	| 'wall'
	| 'sky-cloud'
	| 'sky-flake';

/** Tokens mixed into a ground, each with its share in percent (the ground takes the rest). */
export interface SkyPaint {
	ground: SkyToken;
	mix: readonly (readonly [SkyToken, number])[];
}

/** The wash: a vertical gradient from `top` to `bottom`. */
export interface SkyWash {
	top: SkyPaint;
	bottom: SkyPaint;
}

const paint = (ground: SkyToken, ...mix: (readonly [SkyToken, number])[]): SkyPaint => ({
	ground,
	mix,
});

/**
 * Each sky has its own character (by day on `surface`, by night on `wall`, deepened with `info`
 * and `backdrop`): clear is blue warming toward the horizon, partly a lighter blue, cloudy a cool
 * grey, fog a pale grey, drizzle grey-blue, rain a darker blue-grey, snow a cold pale grey and a
 * storm dark slate.
 */
const WASH: Record<SkyKind, { day: SkyWash; night: SkyWash }> = {
	clear: {
		day: {
			top: paint('surface', ['info', 36]),
			bottom: paint('surface', ['sun', 14], ['info', 6]),
		},
		night: {
			top: paint('wall', ['info', 34], ['backdrop', 10]),
			bottom: paint('wall', ['info', 14], ['backdrop', 4]),
		},
	},
	partly: {
		day: {
			top: paint('surface', ['info', 30]),
			bottom: paint('surface', ['info', 10]),
		},
		night: {
			top: paint('wall', ['info', 28], ['backdrop', 8]),
			bottom: paint('wall', ['info', 12], ['backdrop', 3]),
		},
	},
	cloudy: {
		day: {
			top: paint('surface', ['ink-soft', 22], ['info', 10]),
			bottom: paint('surface', ['ink-soft', 12], ['info', 4]),
		},
		night: {
			top: paint('wall', ['ink-soft', 14], ['info', 8], ['backdrop', 8]),
			bottom: paint('wall', ['ink-soft', 8], ['info', 4]),
		},
	},
	fog: {
		day: {
			top: paint('surface', ['ink-soft', 10]),
			bottom: paint('surface', ['ink-soft', 20]),
		},
		night: {
			top: paint('wall', ['ink-soft', 8]),
			bottom: paint('wall', ['ink-soft', 16]),
		},
	},
	drizzle: {
		day: {
			top: paint('surface', ['ink-soft', 14], ['info', 20], ['backdrop', 6]),
			bottom: paint('surface', ['ink-soft', 8], ['info', 10]),
		},
		night: {
			top: paint('wall', ['ink-soft', 10], ['info', 18], ['backdrop', 8]),
			bottom: paint('wall', ['ink-soft', 6], ['info', 8], ['backdrop', 3]),
		},
	},
	rain: {
		day: {
			top: paint('surface', ['ink-soft', 16], ['info', 22], ['backdrop', 14]),
			bottom: paint('surface', ['ink-soft', 10], ['info', 14], ['backdrop', 3]),
		},
		night: {
			top: paint('wall', ['ink-soft', 10], ['info', 20], ['backdrop', 14]),
			bottom: paint('wall', ['ink-soft', 6], ['info', 10], ['backdrop', 6]),
		},
	},
	snow: {
		day: {
			top: paint('surface', ['ink-soft', 24], ['info', 8]),
			bottom: paint('surface', ['ink-soft', 12], ['info', 4]),
		},
		night: {
			top: paint('wall', ['ink-soft', 14], ['info', 8], ['backdrop', 6]),
			bottom: paint('wall', ['ink-soft', 8], ['info', 4]),
		},
	},
	storm: {
		day: {
			top: paint('surface', ['ink-soft', 26], ['info', 10], ['backdrop', 14]),
			bottom: paint('surface', ['ink-soft', 16], ['info', 6], ['backdrop', 6]),
		},
		night: {
			top: paint('wall', ['ink-soft', 10], ['info', 10], ['backdrop', 18]),
			bottom: paint('wall', ['ink-soft', 8], ['info', 6], ['backdrop', 10]),
		},
	},
};

export function skyWash({ kind, night }: SkyCondition): SkyWash {
	return WASH[kind][night ? 'night' : 'day'];
}

/** How many clouds a sky has (at block size) and how strongly `sky-cloud` is drawn (0 to 1). */
export interface SkyClouds {
	count: number;
	opacity: number;
}

export function skyClouds({ kind }: SkyCondition): SkyClouds {
	switch (kind) {
		case 'clear':
		case 'fog':
			return { count: 0, opacity: 0 };
		case 'partly':
			return { count: 2, opacity: 1 };
		case 'storm':
			return { count: 3, opacity: 0.55 };
		default:
			return { count: 3, opacity: 0.8 };
	}
}

/** Fog banks: `sky-cloud` drawn at this strength. */
export const SKY_FOG_OPACITY = 1;

/** CSS for a paint: nested `color-mix(in srgb, …)` that adds up to the shares in `mix`. */
export function paintCss({ ground, mix }: SkyPaint): string {
	const [first, ...rest] = mix;
	if (!first) return `var(--${ground})`;
	const [token, share] = first;
	const left = 100 - share;
	const inner = paintCss({
		ground,
		mix: rest.map(([t, s]) => [t, Math.round((s / left) * 10000) / 100] as const),
	});
	return `color-mix(in srgb, var(--${token}) ${share}%, ${inner})`;
}

/**
 * Secondary text on the sky: `ink-soft` mixed toward `ink` (this share of `ink-soft` stays), so
 * captions keep 4.5:1 on a tinted wash where plain `ink-soft` would not.
 */
export const SKY_SOFT_INK = 30;

/**
 * The CSS colour of secondary text on the sky. Set it as `--sky-soft` on the element that holds
 * the sky and its text, and `--ink-soft: var(--sky-soft)` on that element's children (a custom
 * property cannot refer to itself on one element).
 */
export const skySoftInk = `color-mix(in srgb, var(--ink-soft) ${SKY_SOFT_INK}%, var(--ink))`;
