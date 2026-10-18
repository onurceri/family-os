import { describe, expect, it } from 'vitest';
import { columnsFor, countFitting } from '../src/web/display-board.ts';

describe('columnsFor', () => {
	it('is 2 below 1280 px and 3 from there', () => {
		expect([800, 1279].map(columnsFor)).toEqual([2, 2]);
		expect([1280, 1920].map(columnsFor)).toEqual([3, 3]);
	});
});

describe('countFitting', () => {
	// Three columns: rows of papers end at 200, 400 and 600 px.
	const bottoms = [200, 200, 200, 400, 400, 400, 600, 600, 600];

	it('shows all when the last paper ends inside the box', () => {
		expect(countFitting(bottoms, 600, 28)).toBe(9);
		expect(countFitting([], 600, 28)).toBe(0);
	});

	it('leaves room for the line that counts the rest', () => {
		// 600 px cannot hold the third row, and the line needs 28 px: two rows.
		expect(countFitting(bottoms, 599, 28)).toBe(6);
		// The second row ends at 400, inside 428 - 28, so it stays.
		expect(countFitting(bottoms, 428, 28)).toBe(6);
		expect(countFitting(bottoms, 427, 28)).toBe(3);
	});

	it('shows none when not even the first paper fits', () => {
		expect(countFitting(bottoms, 150, 28)).toBe(0);
	});
});
