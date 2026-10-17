import { describe, expect, it } from 'vitest';
import {
	baseZoom,
	chooseFit,
	describeFit,
	type FitPlan,
	fitPlans,
	leftOut,
	widgetRows,
} from './fit-plan.js';

const plan = (p: Partial<FitPlan> = {}): FitPlan => ({
	tight: 0,
	rows: 0,
	drop: [],
	hide: [],
	zoom: 1,
	shift: false,
	...p,
});

describe('fitPlans', () => {
	const plans = fitPlans([0, 1, 2], 1.5);
	const firstIndex = (test: (p: FitPlan) => boolean) => plans.findIndex(test);

	it('tries every plan as it is, then with the widgets moved', () => {
		for (let i = 0; i < plans.length; i += 2) {
			expect(plans[i]?.shift).toBe(false);
			expect({ ...plans[i + 1], shift: false }).toEqual(plans[i]);
		}
	});

	it('gives up the decoration first, then widget rows, then the extras and chores, then zoom', () => {
		const photo = firstIndex((p) => p.drop.includes('photo'));
		const hours = firstIndex((p) => p.drop.includes('atmosphere'));
		const rows = firstIndex((p) => p.rows > 0);
		const extras = firstIndex((p) => p.drop.includes('extras'));
		const chores = firstIndex((p) => p.drop.includes('chores'));
		const zoom = firstIndex((p) => p.zoom < 1.5);
		expect(firstIndex((p) => p.tight > 0)).toBeLessThan(photo);
		expect(photo).toBeLessThan(hours);
		expect(hours).toBeLessThan(rows);
		expect(rows).toBeLessThan(extras);
		expect(extras).toBeLessThan(chores);
		expect(chores).toBeLessThan(zoom);
	});

	it('leaves out a widget only at the smallest zoom, and everyone’s status only last', () => {
		const hiding = plans.filter((p) => p.hide.length > 0);
		expect(hiding.length).toBeGreaterThan(0);
		for (const p of hiding) expect(p.zoom).toBe(1);
		const firstHide = firstIndex((p) => p.hide.length > 0);
		expect(firstIndex((p) => p.zoom === 1)).toBeLessThan(firstHide);
		const family = plans.filter((p) => p.drop.includes('family'));
		expect(family).toEqual(plans.slice(-2));
		// The zoom never goes below a person's own Today.
		expect(Math.min(...plans.map((p) => p.zoom))).toBe(1);
	});

	it('leaves out one widget before two, each widget alone, the later ones first', () => {
		const hides = plans.filter((p) => !p.shift && p.hide.length > 0).map((p) => p.hide);
		expect(hides.slice(0, 3)).toEqual([[2], [1], [0]]);
		expect(hides.slice(3, 6)).toEqual([
			[1, 2],
			[0, 2],
			[0, 1],
		]);
		expect(hides[6]).toEqual([0, 1, 2]);
	});

	it('starts from the base zoom of the screen', () => {
		expect(baseZoom(1920)).toBe(1.5);
		expect(baseZoom(1440)).toBe(1.125);
		expect(baseZoom(800)).toBe(1);
		expect(fitPlans([], 1)[0]).toEqual(plan());
	});
});

describe('chooseFit', () => {
	it('takes the first plan that fits, unchanged when it gave up nothing', () => {
		const seen: FitPlan[] = [];
		const pick = chooseFit([0], 1.125, (p) => {
			seen.push(p);
			return true;
		});
		expect(pick).toEqual(plan({ zoom: 1.125 }));
		expect(seen).toHaveLength(1 + 0);
	});

	it('takes back, one at a time, what still fits once the plan fits', () => {
		// Fits only without the photo and with the widgets moved; everything else may come back.
		const pick = chooseFit([0, 1], 1, (p) => p.drop.includes('photo') && p.shift);
		expect(pick).toEqual(plan({ drop: ['photo'], shift: true }));
	});

	it('gives the last plan when nothing fits', () => {
		const plans = fitPlans([0, 1], 1.125);
		expect(chooseFit([0, 1], 1.125, () => false)).toEqual(plans.at(-1));
	});
});

describe('leftOut and describeFit', () => {
	it('names the widgets left out and the groups that had something to show', () => {
		const p = plan({ drop: ['photo', 'atmosphere', 'extras', 'family'], hide: [2] });
		expect(
			leftOut(
				p,
				['board.notes', 'lists.tasks', 'homeassistant.values'],
				new Set(['extras', 'family']),
			),
		).toEqual(['homeassistant.values', 'family', 'extras']);
		expect(leftOut(plan(), ['board.notes'], new Set(['photo']))).toEqual([]);
	});

	it('writes a plan as one short line', () => {
		expect(
			describeFit(plan({ tight: 2, drop: ['photo'], rows: 1, hide: [1], zoom: 1.25, shift: true })),
		).toBe('2|photo|1|1|1.25|shift');
	});

	it('shortens widgets in steps, none at first', () => {
		expect([0, 1, 2, 3, 9].map(widgetRows)).toEqual([undefined, 5, 3, 2, 2]);
	});
});

/* ───────────── the sim family's kitchen wall, on Broadsheet ───────────── */

/**
 * A model of Broadsheet on a family display, measured on the simulated family's wall (five people,
 * one event tomorrow, 21 things to get, four next days, the chores, a photo, who is home, and the
 * widgets: the board, eight open tasks and eight Home Assistant values). Sizes are CSS pixels at
 * zoom 1. The model is the layout's arithmetic: columns of blocks with their gaps, the widgets in
 * columns of at least 18rem, the page's padding outside the zoom.
 */
const SIM = {
	head: 169,
	weather: 165,
	hours: 84,
	photo: 150,
	family: 274,
	chores: 103,
	note: 92,
	day: [268, 268, 240, 200],
	nextDays: 213,
	shopping: 96,
	/** Each widget's height at each `rows` step. */
	widgets: [
		[450, 233, 233, 233],
		[498, 374, 244, 182],
		[496, 340, 205, 154],
	],
};

function stack(heights: readonly number[], gap: number): number {
	const shown = heights.filter((h) => h > 0);
	return shown.reduce((sum, h) => sum + h, 0) + gap * Math.max(0, shown.length - 1);
}

/** The widgets in columns of at least 288 px (20 px apart), each going to the shortest column. */
function band(p: FitPlan, width: number): number {
	const tiles = SIM.widgets.flatMap((rows, i) => (p.hide.includes(i) ? [] : [rows[p.rows] ?? 0]));
	if (tiles.length === 0) return 0;
	const columns = Array.from({ length: Math.max(1, Math.floor((width + 20) / 308)) }, () => 0);
	for (const tile of tiles) {
		const i = columns.indexOf(Math.min(...columns));
		columns[i] = (columns[i] ?? 0) + (columns[i] ? 20 : 0) + tile;
	}
	return 26 + Math.max(...columns);
}

function broadsheetFits(width: number, height: number) {
	return (p: FitPlan): boolean => {
		const gone = (d: string) => p.drop.includes(d as never);
		const wide = width >= 1024;
		const w = (width - (wide ? 80 : 32)) / p.zoom;
		const h = (height - (wide ? 56 : 44)) / p.zoom;
		const weather = SIM.weather + (gone('atmosphere') ? 0 : SIM.hours);
		const photo = gone('photo') ? 0 : SIM.photo;
		const family = gone('family') ? 0 : SIM.family;
		const chores = gone('chores') ? 0 : SIM.chores;
		const day = SIM.day[p.tight] ?? 0;
		const nextDays = gone('extras') ? 0 : SIM.nextDays;
		const shopping = gone('extras') ? 0 : SIM.shopping;
		if (width >= 1280) {
			const fam = shopping;
			const planWidth = w - 280 - (fam ? 328 : 0) - 28;
			const atm = stack([SIM.head, weather, photo, family, chores], 24);
			let plan = stack([SIM.note, day, nextDays], 26);
			let side = fam;
			if (p.shift && fam) side += band(p, 300);
			else plan += band(p, planWidth);
			return Math.max(atm, plan, side) <= h;
		}
		// Held upright: blocks in pairs, the day and the widgets across the page.
		const pairs = [
			Math.max(SIM.head, weather),
			Math.max(family, chores, photo),
			SIM.note,
			day,
			Math.max(shopping, 0),
			nextDays,
		];
		return stack(pairs, 28) + band(p, w) <= h;
	};
}

describe('the sim family’s wall on Broadsheet', () => {
	const widgets = [0, 1, 2];
	const fitAt = (width: number, height: number) =>
		chooseFit(widgets, baseZoom(width), broadsheetFits(width, height));

	it('shows every widget and who is home on a 1920×1080 screen, at the large type', () => {
		const pick = fitAt(1920, 1080);
		expect(pick.hide).toEqual([]);
		expect(pick.drop).not.toContain('family');
		expect(pick.zoom).toBeGreaterThan(1.125);
	});

	it('shows every widget and who is home on a 1440×900 screen', () => {
		const pick = fitAt(1440, 900);
		expect(pick.hide).toEqual([]);
		expect(pick.drop).not.toContain('family');
	});

	it('keeps who is home and the widgets on a 1280×800 screen, held either way', () => {
		for (const [w, h] of [
			[1280, 800],
			[800, 1280],
		] as const) {
			const pick = fitAt(w, h);
			expect(pick.drop).not.toContain('family');
			expect(pick.hide).toEqual([]);
		}
	});

	it('leaves a widget out only when it cannot come back at the smallest type', () => {
		// A screen too short for everything: what is left out could not come back, the photo goes
		// before any widget, and the zoom is a person's own.
		const fits = broadsheetFits(1280, 680);
		const pick = chooseFit(widgets, 1.125, fits);
		expect(fits(pick)).toBe(true);
		expect(pick.hide.length).toBeGreaterThan(0);
		expect(pick.zoom).toBe(1);
		expect(pick.drop).toContain('photo');
		for (const i of pick.hide)
			expect(fits({ ...pick, hide: pick.hide.filter((h) => h !== i) })).toBe(false);
	});
});
