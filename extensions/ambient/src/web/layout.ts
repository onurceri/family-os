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
	/** Portrait only: the panel is tight, so the photo is shorter, the clock smaller, the weather one line. */
	compact: boolean;
	/** Portrait only: the photo's share of the height, in percent. */
	photoPercent: number;
	/** Most event rows the panel lists; they always fit the panel's height. */
	rows: number;
};

/** The most rows of today the panel ever lists. */
const MOST_ROWS = 5;

/**
 * What a panel costs in height (px): everything except the event rows (padding, clock, date, a
 * weather of up to three lines with its attribution, the label, an all-day line and a "+N more"
 * line, all reserved), and one row with its gap.
 */
type Cost = { fixed: number; row: number };
const COST = {
	landscape: { fixed: 340, row: 46 },
	landscapeShort: { fixed: 300, row: 38 },
	portrait: { fixed: 320, row: 38 },
	portraitCompact: { fixed: 250, row: 34 },
} satisfies Record<string, Cost>;
const PHOTO_PERCENT = { portrait: 55, portraitCompact: 45 };

const fit = (panelHeight: number, cost: Cost) =>
	Math.max(Math.floor((panelHeight - cost.fixed) / cost.row), 0);

/** The height the panel gets, given the photo's share when the photo is on top. */
export function panelHeight(viewport: Viewport, photoPercent: number | null): number {
	return photoPercent === null ? viewport.height : (viewport.height * (100 - photoPercent)) / 100;
}

export function slideshowLayout(viewport: Viewport, when: Plan['when']): SlideshowLayout {
	const orientation =
		viewport.height >= viewport.width || viewport.width < PHONE_PX ? 'portrait' : 'landscape';
	const short = viewport.height < SHORT_PX;
	// A phone-wide panel lists three rows at most; a wider, taller one up to five.
	const phone = orientation === 'portrait' && viewport.width < 600;
	const most = when === 'tomorrow' ? TOMORROW_ROWS : phone ? 3 : MOST_ROWS;
	if (when === 'none') {
		return {
			orientation,
			short,
			band: true,
			compact: false,
			photoPercent: PHOTO_PERCENT.portrait,
			rows: 0,
		};
	}
	if (orientation === 'landscape') {
		const cost = short ? COST.landscapeShort : COST.landscape;
		const cap = short ? 3 : most;
		return {
			orientation,
			short,
			band: false,
			compact: false,
			photoPercent: PHOTO_PERCENT.portrait,
			rows: Math.min(cap, Math.max(fit(viewport.height, cost), 1)),
		};
	}
	// Portrait: the usual split when at least three rows fit, else a shorter photo and a smaller panel.
	const usual = Math.min(most, fit(panelHeight(viewport, PHOTO_PERCENT.portrait), COST.portrait));
	if (usual >= Math.min(3, most))
		return {
			orientation,
			short,
			band: false,
			compact: false,
			photoPercent: PHOTO_PERCENT.portrait,
			rows: usual,
		};
	const photoPercent = PHOTO_PERCENT.portraitCompact;
	return {
		orientation,
		short,
		band: false,
		compact: true,
		photoPercent,
		rows: Math.min(
			most,
			Math.max(fit(panelHeight(viewport, photoPercent), COST.portraitCompact), 1),
		),
	};
}

/** The height the chosen rows need in the panel, by the same costs: what the layout checks against. */
export function panelNeeds(layout: SlideshowLayout): number {
	const cost =
		layout.orientation === 'landscape'
			? layout.short
				? COST.landscapeShort
				: COST.landscape
			: layout.compact
				? COST.portraitCompact
				: COST.portrait;
	return cost.fixed + layout.rows * cost.row;
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
