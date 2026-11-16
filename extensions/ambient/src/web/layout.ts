import type { Plan } from './agenda.js';

/** The screen the slideshow is laid out for. */
export type Viewport = { width: number; height: number };

/** A frame lower than this is short: fewer rows and a smaller clock. */
const SHORT_PX = 600;
/** A frame narrower than this is a phone, laid out like a portrait one. */
const PHONE_PX = 480;
/** Rows of tomorrow's plan, at most: it is a glimpse, not the day. */
const TOMORROW_ROWS = 3;

/**
 * How the slideshow is arranged on a screen: the photo beside the plan (landscape) or above it
 * (portrait or phone width); how many event rows the panel has room for; and, when nothing is ahead
 * today or tomorrow, a thin band instead of a panel so the photo gets the room.
 */
export type SlideshowLayout = {
	orientation: 'landscape' | 'portrait';
	/** The frame is short: the clock is one step smaller. */
	short: boolean;
	/** A thin band with the clock, date and weather only. */
	band: boolean;
	/** Most event rows the panel lists. */
	rows: number;
};

export function slideshowLayout(viewport: Viewport, when: Plan['when']): SlideshowLayout {
	const orientation =
		viewport.height >= viewport.width || viewport.width < PHONE_PX ? 'portrait' : 'landscape';
	const short = viewport.height < SHORT_PX;
	const fits = orientation === 'landscape' ? (short ? 3 : 5) : short ? 2 : 3;
	if (when === 'none') return { orientation, short, band: true, rows: 0 };
	return {
		orientation,
		short,
		band: false,
		rows: when === 'tomorrow' ? Math.min(fits, TOMORROW_ROWS) : fits,
	};
}

/** How many of `total` events the panel lists and how many it leaves to "+N more". */
export function rowsShown(total: number, rows: number): { shown: number; more: number } {
	const shown = Math.min(Math.max(total, 0), rows);
	return { shown, more: Math.max(total - shown, 0) };
}

/** The panel changes sides this often (landscape), so a fixed clock never marks the screen. */
export const SWAP_EVERY_MS = 30 * 60_000;

/** Whether the panel changes sides now; asked when the photo changes, so it rides the crossfade. */
export function shouldSwapSide(lastSwap: number, now: number): boolean {
	return now - lastSwap >= SWAP_EVERY_MS;
}
