import { describe, expect, it } from 'vitest';
import {
	panelHeight,
	panelNeeds,
	rowsShown,
	SWAP_EVERY_MS,
	shouldSwapSide,
	slideshowLayout,
} from '../src/web/layout.js';

const sizes = {
	tablet: { width: 1280, height: 800 },
	hd: { width: 1920, height: 1080 },
	frame: { width: 1024, height: 560 },
	phone: { width: 400, height: 860 },
	smallPhone: { width: 360, height: 640 },
	tall: { width: 800, height: 1280 },
};

describe('slideshowLayout', () => {
	it('puts the photo beside a panel of five rows on a landscape screen', () => {
		expect(slideshowLayout(sizes.tablet, 'today')).toMatchObject({
			orientation: 'landscape',
			short: false,
			band: false,
			rows: 5,
		});
		expect(slideshowLayout(sizes.hd, 'today').rows).toBe(5);
	});

	it('keeps the panel and lists three rows with a smaller clock on a short frame', () => {
		expect(slideshowLayout(sizes.frame, 'today')).toMatchObject({
			orientation: 'landscape',
			short: true,
			rows: 3,
		});
		expect(slideshowLayout({ width: 1024, height: 600 }, 'today').short).toBe(false);
	});

	it('puts the photo on top on a portrait screen or phone width', () => {
		for (const size of [sizes.phone, sizes.smallPhone, sizes.tall])
			expect(slideshowLayout(size, 'today').orientation).toBe('portrait');
		expect(slideshowLayout({ width: 440, height: 300 }, 'today').orientation).toBe('portrait');
	});

	it('fits fewer rows and a tighter panel on a phone: a shorter photo, one line of weather', () => {
		const phone = slideshowLayout(sizes.phone, 'today');
		expect(phone).toMatchObject({ compact: true, photoPercent: 45 });
		expect(phone.rows).toBeGreaterThanOrEqual(2);
		expect(phone.rows).toBeLessThanOrEqual(3);
		const small = slideshowLayout(sizes.smallPhone, 'today');
		expect(small.compact).toBe(true);
		expect(small.rows).toBeGreaterThanOrEqual(1);
	});

	it('follows the height on a tall portrait screen: up to five rows, the usual split', () => {
		expect(slideshowLayout(sizes.tall, 'today')).toMatchObject({
			compact: false,
			photoPercent: 55,
			rows: 5,
		});
	});

	it('lists at most three rows of tomorrow', () => {
		expect(slideshowLayout(sizes.tablet, 'tomorrow').rows).toBe(3);
		expect(slideshowLayout(sizes.tall, 'tomorrow').rows).toBe(3);
		expect(slideshowLayout(sizes.smallPhone, 'tomorrow').rows).toBeLessThanOrEqual(3);
	});

	it('becomes a thin band with no rows when nothing is ahead', () => {
		expect(slideshowLayout(sizes.tablet, 'none')).toMatchObject({
			band: true,
			rows: 0,
			orientation: 'landscape',
		});
		expect(slideshowLayout(sizes.phone, 'none')).toMatchObject({
			band: true,
			orientation: 'portrait',
		});
	});

	it('always chooses rows that fit the panel, for every size and plan', () => {
		for (const size of Object.values(sizes))
			for (const when of ['today', 'tomorrow'] as const) {
				const layout = slideshowLayout(size, when);
				const height = panelHeight(
					size,
					layout.orientation === 'portrait' ? layout.photoPercent : null,
				);
				expect(panelNeeds(layout), `${size.width}x${size.height} ${when}`).toBeLessThanOrEqual(
					height,
				);
			}
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
