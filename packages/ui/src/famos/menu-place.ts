/** How close to the window's edge a popover may come, in px. */
export const MENU_EDGE = 8;

export interface MenuPlaceInput {
	/** The left and right edge of the menu's button, in viewport px. */
	anchor: { left: number; right: number };
	/** The menu's width in px. */
	width: number;
	/** The window's width in px. */
	viewport: number;
	/** Which edge of the button the caller lines the menu up with. */
	preferred: 'start' | 'end';
	/** The text direction: `start` is the left edge in `ltr`, the right edge in `rtl`. */
	dir: 'ltr' | 'rtl';
}

/** The left edge a menu lined up with this side of its button would have. */
function leftOf(side: 'start' | 'end', { anchor, width, dir }: MenuPlaceInput): number {
	const leftAligned = (side === 'start') === (dir === 'ltr');
	return leftAligned ? anchor.left : anchor.right - width;
}

/** How many px of the menu would fall outside the window on this side. */
function overflow(side: 'start' | 'end', input: MenuPlaceInput): number {
	const left = leftOf(side, input);
	const right = left + input.width;
	return Math.max(0, MENU_EDGE - left) + Math.max(0, right - (input.viewport - MENU_EDGE));
}

/**
 * Which side of its button a popover menu lines up with: the caller's side while the menu fits in
 * the window, else the other side, so a menu near the window's edge opens back toward the middle
 * instead of running off the screen. When neither fits, the side that hides less of it.
 */
export function menuSide(input: MenuPlaceInput): 'start' | 'end' {
	const other = input.preferred === 'start' ? 'end' : 'start';
	const mine = overflow(input.preferred, input);
	if (mine === 0) return input.preferred;
	return overflow(other, input) < mine ? other : input.preferred;
}
