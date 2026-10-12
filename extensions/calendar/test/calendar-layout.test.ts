import { describe, expect, it } from 'vitest';
import {
	BLOCK,
	blockFit,
	blockHeight,
	clipToDay,
	firstVisibleHour,
	hourHeight,
	layoutDay,
	MIN_BLOCK_HEIGHT,
	maxColumnsFor,
	monthRows,
	overflowOf,
	snapSlot,
} from '../src/web/layout.js';

const h = (hour: number, minute = 0) => hour * 60 + minute;
const by = (placed: ReturnType<typeof layoutDay>) =>
	Object.fromEntries(placed.map((p) => [p.id, p]));

describe('layoutDay', () => {
	it('gives a lone event the whole width', () => {
		expect(layoutDay([{ id: 'a', start: h(9), end: h(10) }])).toEqual([
			{ id: 'a', column: 0, columns: 1, span: 1, cluster: 0, hidden: false },
		]);
	});

	it('puts two overlapping events side by side, the later start on the right', () => {
		const p = by(
			layoutDay([
				{ id: 'late', start: h(9, 30), end: h(10, 30) },
				{ id: 'early', start: h(9), end: h(10) },
			]),
		);
		expect(p.early).toMatchObject({ column: 0, columns: 2 });
		expect(p.late).toMatchObject({ column: 1, columns: 2 });
	});

	it('treats back-to-back events as separate clusters', () => {
		const p = by(
			layoutDay([
				{ id: 'a', start: h(9), end: h(10) },
				{ id: 'b', start: h(10), end: h(11) },
			]),
		);
		expect(p.a).toMatchObject({ column: 0, columns: 1 });
		expect(p.b).toMatchObject({ column: 0, columns: 1 });
	});

	it('reuses a column that has freed up inside a cluster', () => {
		// a is long; b and c are short and follow each other beside it.
		const p = by(
			layoutDay([
				{ id: 'a', start: h(8), end: h(12) },
				{ id: 'b', start: h(8), end: h(9) },
				{ id: 'c', start: h(10), end: h(11) },
			]),
		);
		expect(p.a).toMatchObject({ column: 0, columns: 2 });
		expect(p.b).toMatchObject({ column: 1, columns: 2 });
		expect(p.c).toMatchObject({ column: 1, columns: 2 });
	});

	it('handles nested overlaps with three columns', () => {
		const p = by(
			layoutDay([
				{ id: 'outer', start: h(9), end: h(13) },
				{ id: 'mid', start: h(10), end: h(12) },
				{ id: 'inner', start: h(10, 30), end: h(11, 30) },
			]),
		);
		expect(p.outer).toMatchObject({ column: 0, columns: 3 });
		expect(p.mid).toMatchObject({ column: 1, columns: 3 });
		expect(p.inner).toMatchObject({ column: 2, columns: 3 });
	});

	it('does not widen a separate cluster later in the day', () => {
		const p = by(
			layoutDay([
				{ id: 'a', start: h(9), end: h(10) },
				{ id: 'b', start: h(9), end: h(10) },
				{ id: 'c', start: h(15), end: h(16) },
			]),
		);
		expect(p.a?.columns).toBe(2);
		expect(p.c).toMatchObject({ column: 0, columns: 1 });
	});

	it('counts a very short event as 30 minutes, since it is drawn that tall', () => {
		const p = by(
			layoutDay([
				{ id: 'quick', start: h(9), end: h(9, 5) },
				{ id: 'next', start: h(9, 20), end: h(10) },
			]),
		);
		expect(p.quick?.columns).toBe(2);
		expect(p.next?.column).toBe(1);
	});

	it('keeps the order of its input', () => {
		const out = layoutDay([
			{ id: 'z', start: h(15), end: h(16) },
			{ id: 'a', start: h(8), end: h(9) },
		]);
		expect(out.map((p) => p.id)).toEqual(['z', 'a']);
	});
});

describe('layoutDay widening and overflow', () => {
	it('lets a chip widen into the free columns to its right', () => {
		// Three events share the morning; only the first one runs on into the afternoon.
		const p = by(
			layoutDay([
				{ id: 'long', start: h(9), end: h(13) },
				{ id: 'short', start: h(9), end: h(10) },
				{ id: 'tall', start: h(9), end: h(10) },
				{ id: 'late', start: h(11), end: h(12) },
			]),
		);
		expect(p.long).toMatchObject({ column: 0, columns: 3, span: 1 });
		expect(p.short).toMatchObject({ column: 1, span: 1 });
		// After 10:00 the last column is free beside `late`, so `late` can take two columns.
		expect(p.late).toMatchObject({ column: 1, columns: 3, span: 2 });
	});

	it('keeps a chip at its own column when the next one is taken', () => {
		const p = by(
			layoutDay([
				{ id: 'a', start: h(9), end: h(11) },
				{ id: 'b', start: h(9), end: h(11) },
			]),
		);
		expect(p.a).toMatchObject({ column: 0, columns: 2, span: 1 });
		expect(p.b).toMatchObject({ column: 1, columns: 2, span: 1 });
	});

	it('hides what does not fit and counts it in one "+N more" chip', () => {
		// Four events at once with room for three columns: two stay, two are counted.
		const spans = [
			{ id: 'a', start: h(15), end: h(16) },
			{ id: 'b', start: h(15), end: h(16) },
			{ id: 'c', start: h(15), end: h(16) },
			{ id: 'd', start: h(15, 30), end: h(17) },
			{ id: 'later', start: h(19), end: h(20) },
		];
		const placed = layoutDay(spans, undefined, 3);
		const p = by(placed);
		expect(p.a).toMatchObject({ column: 0, columns: 3, hidden: false });
		expect(p.b).toMatchObject({ column: 1, columns: 3, hidden: false });
		expect(p.c).toMatchObject({ column: 2, hidden: true });
		expect(p.d).toMatchObject({ column: 3, hidden: true });
		expect(p.later).toMatchObject({ column: 0, columns: 1, hidden: false });
		expect(overflowOf(spans, placed)).toEqual([
			{ cluster: p.a?.cluster, column: 2, columns: 3, start: h(15), end: h(17), count: 2 },
		]);
	});

	it('never widens a chip over the "+N more" column', () => {
		const placed = layoutDay(
			[
				{ id: 'a', start: h(9), end: h(10) },
				{ id: 'b', start: h(9), end: h(10) },
				{ id: 'c', start: h(9), end: h(10) },
			],
			undefined,
			2,
		);
		expect(placed.map((p) => [p.column, p.span, p.hidden])).toEqual([
			[0, 1, false],
			[1, 1, true],
			[2, 1, true],
		]);
	});

	it('gives no overflow when everything fits', () => {
		const spans = [
			{ id: 'a', start: h(9), end: h(10) },
			{ id: 'b', start: h(9), end: h(10) },
		];
		expect(overflowOf(spans, layoutDay(spans, undefined, 3))).toEqual([]);
	});

	it('holds at least two columns, and a readable width for each', () => {
		expect(maxColumnsFor(94)).toBe(2);
		expect(maxColumnsFor(190)).toBe(3);
		expect(maxColumnsFor(1000)).toBe(6);
	});
});

describe('clipToDay', () => {
	const DAY = 86_400_000;
	const minutesOf = (at: number) => Math.round(at / 60_000);
	it('clips an event crossing midnight to both days', () => {
		const start = 22 * 3_600_000;
		const end = DAY + 2 * 3_600_000;
		expect(clipToDay(start, end, 0, DAY, minutesOf)).toEqual({ start: h(22), end: 1440 });
		expect(clipToDay(start, end, DAY, 2 * DAY, (at) => minutesOf(at - DAY))).toEqual({
			start: 0,
			end: h(2),
		});
	});
	it('covers the whole day for an event spanning it', () => {
		expect(clipToDay(-DAY, 2 * DAY, 0, DAY, minutesOf)).toEqual({ start: 0, end: 1440 });
	});
	it('returns null for an event that only touches the day edge', () => {
		expect(clipToDay(DAY, DAY + 1000, 0, DAY, minutesOf)).toBeNull();
		expect(clipToDay(-1000, 0, 0, DAY, minutesOf)).toBeNull();
	});
});

describe('grid helpers', () => {
	it('sizes the hour from the body height', () => {
		expect(hourHeight(500)).toBe(44);
		expect(hourHeight(728)).toBe(52);
		expect(hourHeight(1400)).toBe(100);
	});
	it('opens at 07:00 or an hour before the first event', () => {
		expect(firstVisibleHour(null)).toBe(7);
		expect(firstVisibleHour(h(12))).toBe(7);
		expect(firstVisibleHour(h(8, 30))).toBe(7);
		expect(firstVisibleHour(h(7))).toBe(6);
		expect(firstVisibleHour(h(0, 30))).toBe(0);
	});
	it('fits month rows to the cell', () => {
		expect(monthRows(60)).toBe(1);
		expect(monthRows(36 + 23 * 3)).toBe(3);
		expect(monthRows(150)).toBe(4);
	});
	it('snaps slots to 30 minutes', () => {
		expect(snapSlot(h(10, 29))).toBe(h(10));
		expect(snapSlot(h(10, 31))).toBe(h(10, 30));
		expect(snapSlot(1439)).toBe(1410);
	});
});

describe('event blocks on the hour grid', () => {
	// The height that holds `title` title lines and `meta` lines under it, with the normal padding.
	const tall = (title: number, meta: number) =>
		2 * BLOCK.border + 2 * BLOCK.pad + title * BLOCK.title + meta * BLOCK.meta;
	// The same with the thin padding: the least a block can hold these lines in.
	const snug = (title: number, meta: number) => tall(title, meta) - 2 * (BLOCK.pad - BLOCK.tight);

	it('never draws a block shorter than one whole title line', () => {
		expect(MIN_BLOCK_HEIGHT).toBe(2 * BLOCK.border + 2 * BLOCK.tight + BLOCK.title);
		// 15 minutes at the smallest hour (44 px) would be 10 px.
		expect(blockHeight(15, 44)).toBe(MIN_BLOCK_HEIGHT);
		// 30 minutes at the smallest hour is exactly the shortest block.
		expect(blockHeight(30, 44)).toBe(MIN_BLOCK_HEIGHT);
		expect(blockHeight(60, 90)).toBe(89);
	});
	it('shows only the title, on one line, when a second line would be cut', () => {
		// The shortest blocks hold their title only with the thin padding.
		for (const height of [MIN_BLOCK_HEIGHT, tall(1, 0) - 1])
			expect(blockFit(height, 1)).toEqual({ titleLines: 1, metaLines: 0, tight: true });
		for (const height of [tall(1, 0), 30, snug(1, 1) - 1])
			expect(blockFit(height, 1)).toEqual({ titleLines: 1, metaLines: 0, tight: false });
	});
	it('thins the padding when that lets the line under the title fit whole', () => {
		// 45 minutes at 50 px an hour: 36 px.
		expect(blockFit(blockHeight(45, 50), 1)).toEqual({ titleLines: 1, metaLines: 1, tight: true });
		expect(blockFit(tall(1, 1) - 1, 1)).toEqual({ titleLines: 1, metaLines: 1, tight: true });
		expect(blockFit(tall(1, 1), 1)).toEqual({ titleLines: 1, metaLines: 1, tight: false });
		// 30 minutes at 90 px an hour, the size the bug was seen at.
		expect(blockFit(blockHeight(30, 90), 1)).toEqual({
			titleLines: 1,
			metaLines: 1,
			tight: false,
		});
	});
	it('wraps the title once with the room left after the lines under it', () => {
		expect(blockFit(snug(2, 1) - 1, 1)).toMatchObject({ titleLines: 1, metaLines: 1 });
		expect(blockFit(snug(2, 1), 1)).toMatchObject({ titleLines: 2, metaLines: 1 });
		expect(blockFit(tall(2, 1), 1)).toEqual({ titleLines: 2, metaLines: 1, tight: false });
		expect(blockFit(tall(2, 0), 0)).toEqual({ titleLines: 2, metaLines: 0, tight: false });
	});
	it('fits only the lines that are wanted and that fit whole', () => {
		expect(blockFit(snug(1, 3), 3).metaLines).toBe(3);
		expect(blockFit(snug(1, 3) - 1, 3).metaLines).toBe(2);
		expect(blockFit(500, 3)).toMatchObject({ titleLines: 2, metaLines: 3 });
	});
	it('never chooses more lines than the block holds', () => {
		for (let height = MIN_BLOCK_HEIGHT; height <= 200; height++)
			for (let wanted = 0; wanted <= 3; wanted++) {
				const fit = blockFit(height, wanted);
				const pad = fit.tight ? BLOCK.tight : BLOCK.pad;
				const used =
					2 * BLOCK.border + 2 * pad + fit.titleLines * BLOCK.title + fit.metaLines * BLOCK.meta;
				expect(used).toBeLessThanOrEqual(height);
			}
	});
});
