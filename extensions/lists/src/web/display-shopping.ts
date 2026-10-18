/** How the shopping page of a family display fits its box: columns, rows and what is left out. */

/** The lists shown side by side; the rest are counted. */
export const MAX_LISTS = 3;

/** One list: 1 column below 1024 px, 2 up to 1600 px, 3 above. */
export const columnsFor = (width: number): 1 | 2 | 3 => (width < 1024 ? 1 : width <= 1600 ? 2 : 3);

/** How many rows of `row` px with `gap` px between them fit in `space` px. */
export const rowsFit = (space: number, row: number, gap: number): number =>
	row > 0 ? Math.max(0, Math.floor((space + gap) / (row + gap))) : 0;

export interface Measures {
	/** The box, px. */
	height: number;
	/** One item row, px. */
	row: number;
	gap: number;
	/** The line that says how many are left out, px. */
	note: number;
}

/**
 * One list in `columns` columns, filled down then across. Everything shows when it fits; otherwise
 * a line at the foot says how many are left out and the rows above it are filled.
 */
export function planSingle(
	total: number,
	columns: number,
	m: Measures,
): { rows: number; shown: number; more: number } {
	const all = rowsFit(m.height, m.row, m.gap) * columns;
	if (total <= all) return { rows: Math.ceil(total / columns), shown: total, more: 0 };
	const rows = rowsFit(m.height - m.note - m.gap, m.row, m.gap);
	const shown = Math.min(rows * columns, total);
	return { rows, shown, more: total - shown };
}

/**
 * Up to `MAX_LISTS` lists, one column each, with `head` px of label above the items. `counts` are
 * the open items of the lists drawn, in order; `hiddenLists` more lists are not drawn. Returns how many items each shown column
 * holds, how many items are left out of them, and how many lists are not shown at all.
 */
export function planLists(
	counts: readonly number[],
	m: Measures & { head: number },
	hiddenLists = 0,
): { shown: number[]; moreItems: number; moreLists: number } {
	const lists = counts.slice(0, MAX_LISTS);
	const moreLists = hiddenLists + Math.max(0, counts.length - MAX_LISTS);
	const whole = rowsFit(m.height - m.head - m.gap, m.row, m.gap);
	if (moreLists === 0 && lists.every((n) => n <= whole)) {
		return { shown: [...lists], moreItems: 0, moreLists };
	}
	const rows = rowsFit(m.height - m.head - m.gap - m.note - m.gap, m.row, m.gap);
	const shown = lists.map((n) => Math.min(n, rows));
	const moreItems = lists.reduce((sum, n, i) => sum + n - (shown[i] as number), 0);
	return { shown, moreItems, moreLists };
}
