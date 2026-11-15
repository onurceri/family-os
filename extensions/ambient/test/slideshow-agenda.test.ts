import { describe, expect, it } from 'vitest';
import { slideshowAgenda } from '../src/web/agenda.js';

const tall = { width: 1280, height: 800 };

describe('slideshowAgenda', () => {
	it('shows nothing when nothing is left today', () => {
		expect(slideshowAgenda(0, tall)).toEqual({ rows: 0, more: 0, tallScrim: false });
	});

	it('shows one row with the normal gradient for one event', () => {
		expect(slideshowAgenda(1, tall)).toEqual({ rows: 1, more: 0, tallScrim: false });
	});

	it('shows two and three rows with the taller gradient', () => {
		expect(slideshowAgenda(2, tall)).toEqual({ rows: 2, more: 0, tallScrim: true });
		expect(slideshowAgenda(3, tall)).toEqual({ rows: 3, more: 0, tallScrim: true });
	});

	it('shows three rows and counts the rest, never a fourth row', () => {
		expect(slideshowAgenda(4, tall)).toEqual({ rows: 3, more: 1, tallScrim: true });
		expect(slideshowAgenda(5, tall)).toEqual({ rows: 3, more: 2, tallScrim: true });
	});

	it('keeps one row and no "more" line on a short or narrow screen', () => {
		expect(slideshowAgenda(5, { width: 1280, height: 599 })).toEqual({
			rows: 1,
			more: 0,
			tallScrim: false,
		});
		expect(slideshowAgenda(5, { width: 390, height: 844 })).toEqual({
			rows: 1,
			more: 0,
			tallScrim: false,
		});
		expect(slideshowAgenda(0, { width: 390, height: 844 }).rows).toBe(0);
	});

	it('treats exactly 600 px as large enough', () => {
		expect(slideshowAgenda(4, { width: 600, height: 600 }).rows).toBe(3);
	});
});
