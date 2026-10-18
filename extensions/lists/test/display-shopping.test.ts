import { describe, expect, it } from 'vitest';
import {
	columnsFor,
	MAX_LISTS,
	planLists,
	planSingle,
	rowsFit,
} from '../src/web/display-shopping.ts';

// 60 px rows 12 px apart: ten rows need 10 * 60 + 9 * 12 = 708 px.
const m = { height: 708, row: 60, gap: 12, note: 28 };

describe('columnsFor', () => {
	it('is 1 below 1024 px, 2 up to 1600 px and 3 above', () => {
		expect([800, 1023].map(columnsFor)).toEqual([1, 1]);
		expect([1024, 1280, 1600].map(columnsFor)).toEqual([2, 2, 2]);
		expect([1601, 1920].map(columnsFor)).toEqual([3, 3]);
	});
});

describe('rowsFit', () => {
	it('counts the rows and the gaps between them', () => {
		expect(rowsFit(708, 60, 12)).toBe(10);
		expect(rowsFit(707, 60, 12)).toBe(9);
		expect(rowsFit(10, 60, 12)).toBe(0);
		expect(rowsFit(500, 0, 12)).toBe(0);
	});
});

describe('planSingle', () => {
	it('shows everything that fits, balanced over the columns', () => {
		expect(planSingle(25, 3, m)).toEqual({ rows: 9, shown: 25, more: 0 });
		expect(planSingle(3, 1, m)).toEqual({ rows: 3, shown: 3, more: 0 });
	});

	it('fills the rows above the foot line and counts the rest', () => {
		// 25 items in one column: 708 - 28 - 12 = 668 px holds 9 rows.
		expect(planSingle(25, 1, m)).toEqual({ rows: 9, shown: 9, more: 16 });
		// Two columns hold 20 whole, so 25 fill 9 rows of 2.
		expect(planSingle(25, 2, m)).toEqual({ rows: 9, shown: 18, more: 7 });
	});

	it('uses the whole box when the items fill it exactly', () => {
		expect(planSingle(10, 1, m)).toEqual({ rows: 10, shown: 10, more: 0 });
		expect(planSingle(11, 1, m)).toEqual({ rows: 9, shown: 9, more: 2 });
	});
});

describe('planLists', () => {
	const w = { ...m, head: 36 };

	it('shows every list whole when they fit', () => {
		expect(planLists([4, 9, 2], w)).toEqual({ shown: [4, 9, 2], moreItems: 0, moreLists: 0 });
	});

	it('cuts long lists at the foot line and counts what is left out', () => {
		// 708 - 36 - 12 - 28 - 12 = 620 px holds 8 rows.
		expect(planLists([25, 3, 9], w)).toEqual({ shown: [8, 3, 8], moreItems: 18, moreLists: 0 });
	});

	it('shows three lists and counts the others', () => {
		const out = planLists([2, 2, 2], w, 2);
		expect(out.shown).toEqual([2, 2, 2]);
		expect(out.moreItems).toBe(0);
		expect(out.moreLists).toBe(2);
		expect(planLists([2, 2, 2, 2, 5], w).moreLists).toBe(2);
		expect(MAX_LISTS).toBe(3);
	});
});
