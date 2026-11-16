import { describe, expect, it } from 'vitest';
import { rowsShown, SWAP_EVERY_MS, shouldSwapSide, slideshowLayout } from '../src/web/layout.js';

describe('slideshowLayout', () => {
	it('puts the photo beside a panel of five rows on a landscape screen', () => {
		expect(slideshowLayout({ width: 1280, height: 800 }, 'today')).toEqual({
			orientation: 'landscape',
			short: false,
			band: false,
			rows: 5,
		});
		expect(slideshowLayout({ width: 1920, height: 1080 }, 'today').rows).toBe(5);
	});

	it('keeps the panel and lists three rows with a smaller clock on a short frame', () => {
		expect(slideshowLayout({ width: 1024, height: 559 }, 'today')).toEqual({
			orientation: 'landscape',
			short: true,
			band: false,
			rows: 3,
		});
		expect(slideshowLayout({ width: 1024, height: 600 }, 'today').short).toBe(false);
	});

	it('puts the photo on top on a portrait screen or phone width, with three rows', () => {
		expect(slideshowLayout({ width: 400, height: 860 }, 'today')).toMatchObject({
			orientation: 'portrait',
			rows: 3,
		});
		expect(slideshowLayout({ width: 800, height: 1280 }, 'today').orientation).toBe('portrait');
		expect(slideshowLayout({ width: 440, height: 300 }, 'today').orientation).toBe('portrait');
	});

	it('lists two rows on a short portrait frame', () => {
		expect(slideshowLayout({ width: 300, height: 420 }, 'today').rows).toBe(2);
	});

	it('lists at most three rows of tomorrow', () => {
		expect(slideshowLayout({ width: 1280, height: 800 }, 'tomorrow').rows).toBe(3);
		expect(slideshowLayout({ width: 300, height: 420 }, 'tomorrow').rows).toBe(2);
	});

	it('becomes a thin band with no rows when nothing is ahead', () => {
		expect(slideshowLayout({ width: 1280, height: 800 }, 'none')).toMatchObject({
			band: true,
			rows: 0,
			orientation: 'landscape',
		});
		expect(slideshowLayout({ width: 400, height: 860 }, 'none')).toMatchObject({
			band: true,
			orientation: 'portrait',
		});
	});
});

describe('rowsShown', () => {
	it('lists what fits and counts the rest', () => {
		expect(rowsShown(7, 5)).toEqual({ shown: 5, more: 2 });
		expect(rowsShown(5, 5)).toEqual({ shown: 5, more: 0 });
		expect(rowsShown(2, 5)).toEqual({ shown: 2, more: 0 });
		expect(rowsShown(0, 0)).toEqual({ shown: 0, more: 0 });
	});
});

describe('the panel changing sides', () => {
	it('swaps after half an hour and not before', () => {
		expect(shouldSwapSide(0, SWAP_EVERY_MS - 1)).toBe(false);
		expect(shouldSwapSide(0, SWAP_EVERY_MS)).toBe(true);
	});
});
