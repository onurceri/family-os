import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SKY_KINDS,
	type SkyKind,
	skyCondition,
	type TodayFormat,
	WeatherBlock,
	WeatherSky,
} from '../src/famos/index.js';
import { cleanup, q, qa, render } from './helpers.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** Every WMO weather interpretation code Open-Meteo sends, with the sky it draws. */
const WMO: Record<number, SkyKind> = {
	0: 'clear',
	1: 'clear',
	2: 'partly',
	3: 'cloudy',
	45: 'fog',
	48: 'fog',
	51: 'drizzle',
	53: 'drizzle',
	55: 'drizzle',
	56: 'drizzle',
	57: 'drizzle',
	61: 'rain',
	63: 'rain',
	65: 'rain',
	66: 'rain',
	67: 'rain',
	71: 'snow',
	73: 'snow',
	75: 'snow',
	77: 'snow',
	80: 'rain',
	81: 'rain',
	82: 'rain',
	85: 'snow',
	86: 'snow',
	95: 'storm',
	96: 'storm',
	99: 'storm',
};
/** One code per sky, for rendering. */
const SAMPLE: Record<SkyKind, number> = {
	clear: 0,
	partly: 2,
	cloudy: 3,
	fog: 45,
	drizzle: 51,
	rain: 61,
	snow: 71,
	storm: 95,
};

describe('skyCondition', () => {
	it('maps every WMO code to its sky, by day and by night', () => {
		for (const [code, kind] of Object.entries(WMO)) {
			expect(skyCondition(Number(code), true), `code ${code}`).toEqual({ kind, night: false });
			expect(skyCondition(Number(code), false), `code ${code}`).toEqual({ kind, night: true });
		}
	});

	it('draws an overcast sky for a code it does not know', () => {
		for (const code of [4, 10, 50, 60, 70, 90, 100, -1])
			expect(skyCondition(code, true).kind).toBe('cloudy');
	});
});

describe('WeatherSky', () => {
	it('renders each sky by day and by night, with few moving parts', () => {
		for (const kind of SKY_KINDS) {
			for (const isDay of [true, false]) {
				for (const size of ['block', 'screen'] as const) {
					const el = render(WeatherSky, { code: SAMPLE[kind], isDay, size });
					const sky = q('[data-testid="weather-sky"]', el);
					expect(sky.dataset.sky).toBe(kind);
					expect(sky.dataset.night).toBe(String(!isDay));
					expect(sky.getAttribute('aria-hidden')).toBe('true');
					const moving = qa('.m', sky).length;
					expect(moving, `${kind} ${size}`).toBeGreaterThan(0);
					expect(moving, `${kind} ${size}`).toBeLessThanOrEqual(30);
					cleanup();
				}
			}
		}
	});

	it('draws what the weather is: sun by day, moon and stars at night, rain, snow, a flash', () => {
		const parts = (code: number, isDay: boolean) => {
			const el = render(WeatherSky, { code, isDay });
			const found = ['sun', 'moon', 'stars', 'cloud', 'bank', 'rain', 'snow', 'flash'].filter((c) =>
				el.querySelector(`.${c}`),
			);
			cleanup();
			return found;
		};
		expect(parts(0, true)).toEqual(['sun']);
		expect(parts(0, false)).toEqual(['moon', 'stars']);
		expect(parts(2, true)).toEqual(['sun', 'cloud']);
		expect(parts(45, true)).toEqual(['bank']);
		expect(parts(61, true)).toEqual(['cloud', 'rain']);
		expect(parts(71, false)).toEqual(['cloud', 'snow']);
		expect(parts(95, true)).toEqual(['cloud', 'rain', 'flash']);
	});

	it('stands still when asked, and when the person prefers reduced motion', () => {
		let el = render(WeatherSky, { code: 61, isDay: true });
		expect(q('[data-testid="weather-sky"]', el).dataset.still).toBe('false');
		cleanup();
		el = render(WeatherSky, { code: 61, isDay: true, still: true });
		expect(q('[data-testid="weather-sky"]', el).dataset.still).toBe('true');
		cleanup();
		vi.stubGlobal('matchMedia', (query: string) => ({
			matches: query.includes('prefers-reduced-motion'),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		el = render(WeatherSky, { code: 61, isDay: true });
		expect(q('[data-testid="weather-sky"]', el).dataset.still).toBe('true');
	});
});

describe('WeatherBlock with a sky', () => {
	const format: TodayFormat = {
		formatLocale: 'en-GB',
		dateLocale: 'en-GB',
		hourCycle: 'h23',
		timeZone: 'UTC',
	};

	it('draws the sky behind the block only when given one', () => {
		let el = render(WeatherBlock, { temperature: 14, format, stripLabel: 'Next hours' });
		expect(el.querySelector('[data-testid="weather-sky"]')).toBeNull();
		cleanup();
		el = render(WeatherBlock, {
			temperature: 14,
			format,
			stripLabel: 'Next hours',
			summary: 'Rain',
			sky: { code: 63, isDay: false },
		});
		const block = q('[data-testid="weather-block"]', el);
		expect(block.classList.contains('has-sky')).toBe(true);
		expect(block.style.getPropertyValue('--sky-soft')).toContain('var(--ink-soft)');
		expect(q('[data-testid="weather-sky"]', block).dataset.sky).toBe('rain');
		expect(block.textContent).toContain('Rain');
	});
});
