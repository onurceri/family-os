import { describe, expect, it } from 'vitest';
import {
	channelsCss,
	colorChannels,
	colorVars,
	mixChannels,
	TRANSPARENT,
	varChannels,
} from '../src/colors.ts';
import { paintCss, skySoftVars } from '../src/famos/sky.ts';

describe('colorVars', () => {
	it('sets a hex color and its channels', () => {
		expect(colorVars('m', '#c82878')).toBe(
			'--m: #c82878; --m-r: 200; --m-g: 40; --m-b: 120; --m-a: 1',
		);
		expect(colorVars('m', '#fff8')).toBe(
			'--m: #fff8; --m-r: 255; --m-g: 255; --m-b: 255; --m-a: 0.5333',
		);
	});

	it('sets an rgb() color and its channels', () => {
		expect(colorVars('paper', 'rgb(10 20 30 / 0.5)')).toBe(
			'--paper: rgb(10 20 30 / 0.5); --paper-r: 10; --paper-g: 20; --paper-b: 30; --paper-a: 0.5',
		);
		expect(colorVars('paper', 'rgba(10, 20, 30, 50%)')).toContain('--paper-a: 0.5');
	});

	it("aliases a token's channels", () => {
		expect(colorVars('paper', 'var(--note-1)')).toBe(
			'--paper: var(--note-1); --paper-r: var(--note-1-r); --paper-g: var(--note-1-g); --paper-b: var(--note-1-b); --paper-a: var(--note-1-a)',
		);
		expect(colorVars('m', 'var(--lamp, #000)')).toContain('--m-r: var(--lamp-r,0)');
	});

	it('sets nothing for no color, and no channels for a color it cannot read', () => {
		expect(colorVars('m', undefined)).toBeUndefined();
		expect(colorVars('m', '')).toBeUndefined();
		expect(colorVars('m', 'tomato')).toBe('--m: tomato');
	});
});

describe('mixChannels', () => {
	it('mixes with transparent by scaling alpha', () => {
		expect(mixChannels(varChannels('--ink', undefined, true), 10, TRANSPARENT, null)).toEqual({
			r: 'var(--ink-r)',
			g: 'var(--ink-g)',
			b: 'var(--ink-b)',
			a: '0.1',
		});
	});

	it('folds literal colors to numbers', () => {
		const red = colorChannels('#ff0000');
		const blue = colorChannels('#0000ff');
		if (!red || !blue) throw new Error('unreadable');
		expect(channelsCss(mixChannels(red, 25, blue, null) as typeof red)).toBe(
			'rgb(63.75 0 191.25 / 1)',
		);
		expect(mixChannels(red, 0, blue, 0)).toBeNull();
	});
});

describe('the sky without color-mix', () => {
	it('paints from channels', () => {
		expect(paintCss({ ground: 'surface', mix: [['info', 20]] }, false)).toBe(
			'rgb(calc(var(--info-r) * 0.2 + var(--surface-r) * 0.8) calc(var(--info-g) * 0.2 + var(--surface-g) * 0.8) calc(var(--info-b) * 0.2 + var(--surface-b) * 0.8) / 1)',
		);
		expect(paintCss({ ground: 'wall', mix: [] }, false)).toBe('var(--wall)');
	});

	it('sets the soft ink and its channels', () => {
		const style = skySoftVars(false);
		expect(style).toMatch(
			/^--sky-soft: rgb\(calc\(var\(--ink-soft-r\) \* 0\.3 \+ var\(--ink-r\) \* 0\.7\)/,
		);
		expect(style).toContain('--sky-soft-a: 1');
		expect(skySoftVars(true)).toMatch(
			/^--sky-soft: color-mix\(in srgb, var\(--ink-soft\) 30%, var\(--ink\)\);/,
		);
	});
});

describe('colorChannels on hostile input', () => {
	it('reads var() with and without a fallback', () => {
		expect(colorChannels('var(--ink)')).not.toBeNull();
		expect(colorChannels(' var( --ink , #ff0000 ) ')).not.toBeNull();
		expect(colorChannels('var(--ink, )')).toBeNull();
		expect(colorChannels('var(ink)')).toBeNull();
	});

	it('answers quickly on long inputs that make a backtracking pattern slow', () => {
		const started = performance.now();
		colorChannels(`var(---,${'\t'.repeat(50_000)}`);
		colorChannels(`var(---,a${'\t'.repeat(50_000)}`);
		expect(performance.now() - started).toBeLessThan(100);
	});
});
