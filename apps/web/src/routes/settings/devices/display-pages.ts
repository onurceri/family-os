/**
 * What a screen's panel offers for the pages the screen shows between Today's turns, as plain
 * data so it is tested without a browser.
 */

/** A `display.page` contribution, as far as the panel is concerned. */
export interface PageContribution {
	slot: string;
	id: string;
	requires?: string;
	labelKey?: string;
}

export interface PagesChoice {
	pages: string[];
	todaySeconds: number;
	pageSeconds: number;
	backSeconds: number;
}

/** What a screen shows when nothing was chosen: the durations the server fills in as well. */
export const DEFAULT_DURATIONS = { todaySeconds: 120, pageSeconds: 30, backSeconds: 120 } as const;

/** The durations the panel offers, in seconds. */
export const TODAY_SECONDS = [30, 60, 120, 300, 600, 1800] as const;
export const PAGE_SECONDS = [10, 20, 30, 45, 60, 120, 300] as const;
export const BACK_SECONDS = [30, 60, 120, 300, 600] as const;

/**
 * Whether the screen has something that takes it over when nobody touches it (ambient mode, a
 * contribution of `display.ambient` whose permission is ticked): with pages, that content comes
 * as a page instead, which the panel says.
 */
export function takesOverWhenIdle(
	contributions: readonly { slot: string; requires?: string }[],
	ticked: readonly string[],
): boolean {
	return contributions.some(
		(c) => c.slot === 'display.ambient' && c.requires !== undefined && ticked.includes(c.requires),
	);
}

/**
 * The pages that can be added: those the extension offers (and has turned on) whose capability
 * is ticked in the form above, and that are not in the list yet.
 */
export function addablePages<C extends PageContribution>(
	contributions: readonly C[],
	ticked: readonly string[],
	chosen: readonly string[],
	disabled: readonly string[],
): C[] {
	return contributions.filter(
		(c) =>
			c.slot === 'display.page' &&
			c.requires !== undefined &&
			ticked.includes(c.requires) &&
			!chosen.includes(c.id) &&
			!disabled.includes(c.id.split('.')[0] ?? ''),
	);
}

/**
 * The chosen pages the panel can show: in order, only those that exist and whose capability is
 * still ticked. A page whose capability is unticked disappears and is not saved.
 */
export function listedPages<C extends PageContribution>(
	contributions: readonly C[],
	ticked: readonly string[],
	chosen: readonly string[],
	disabled: readonly string[],
): C[] {
	return chosen.flatMap((id) => {
		const found = contributions.find((c) => c.slot === 'display.page' && c.id === id);
		return found?.requires !== undefined &&
			ticked.includes(found.requires) &&
			!disabled.includes(id.split('.')[0] ?? '')
			? [found]
			: [];
	});
}

/** The list's values with the current one among them, even when it is not a usual choice. */
export function withCurrent(values: readonly number[], current: number): number[] {
	return values.includes(current) ? [...values] : [...values, current].toSorted((a, b) => a - b);
}

/** Moves the page at `index` by one place (`-1` up, `1` down); the same list at the ends. */
export function movePage(ids: readonly string[], index: number, by: -1 | 1): string[] {
	const to = index + by;
	if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return [...ids];
	const next = [...ids];
	[next[index], next[to]] = [next[to] as string, next[index] as string];
	return next;
}

/** What is saved: nothing (`null`) when no page is chosen, so the screen shows only Today. */
export function rotationToSave(choice: PagesChoice): PagesChoice | null {
	return choice.pages.length === 0 ? null : choice;
}

/** Whether two choices differ (the order of pages counts). */
export const pagesChanged = (a: PagesChoice, b: PagesChoice): boolean =>
	a.pages.join() !== b.pages.join() ||
	a.todaySeconds !== b.todaySeconds ||
	a.pageSeconds !== b.pageSeconds ||
	a.backSeconds !== b.backSeconds;
