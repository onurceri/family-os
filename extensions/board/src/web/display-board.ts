/** How the board page of a family display fits its box: columns and how many papers fit. */

/** Two columns below 1280 px, three from there. */
export const columnsFor = (width: number): 2 | 3 => (width < 1280 ? 2 : 3);

/**
 * How many papers fit, given the bottom edge of each (px from the top of the box, in board order).
 * All of them when the last one ends inside the box; otherwise the ones above the line that says
 * how many are left out, which takes `note` px at the foot.
 */
export function countFitting(bottoms: readonly number[], height: number, note: number): number {
	if (bottoms.every((bottom) => bottom <= height + 0.5)) return bottoms.length;
	const limit = height - note;
	const cut = bottoms.findIndex((bottom) => bottom > limit + 0.5);
	return Math.max(cut, 0);
}
