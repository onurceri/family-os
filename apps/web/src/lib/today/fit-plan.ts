/**
 * How a family display fits its one screen, as plain data so it is tested without a browser.
 * The display measures; this module only says which plans to try, in which order, and what a
 * chosen plan left out.
 *
 * What may be left out, by group: the `photo`, the weather's hours (`atmosphere`), the `extras`
 * (shopping, the kitchen, the next days and what is ahead), the `chores`, and everyone's status
 * with who is home (`family`). The head, the next thing and the day are never left out.
 */
export type FitDrop = 'photo' | 'atmosphere' | 'extras' | 'chores' | 'family';

/** One way to lay the display out. */
export interface FitPlan {
	/** 0: the style's own limits; 1 to 3: fewer things per person (a column, a lane, a list). */
	readonly tight: number;
	/** 0: each widget's own length; 1 to 3: fewer rows in every widget (`widgetRows`). */
	readonly rows: number;
	readonly drop: readonly FitDrop[];
	/** The widgets (their index in the band) the plan leaves out. */
	readonly hide: readonly number[];
	readonly zoom: number;
	/** The style moves its widgets and smaller blocks to the column with room. */
	readonly shift: boolean;
}

/** The most rows a widget shows at each `rows` step (none: the widget's own limit). */
const WIDGET_ROWS: readonly (number | undefined)[] = [undefined, 5, 3, 2];
export const widgetRows = (rows: number): number | undefined =>
	WIDGET_ROWS[Math.min(Math.max(rows, 0), WIDGET_ROWS.length - 1)];

/** One type step larger than on a person's screen from 1024 px, a TV-sized screen one more. */
export const baseZoom = (width: number): number =>
	width >= 1800 ? 1.5 : width >= 1024 ? 1.125 : 1;
/** The zoom comes down in small steps, never below a person's own Today (1). */
const ZOOM_STEP = 0.0625;

/** What goes first: decoration, then the weather's hours; the granted blocks only later. */
const DECORATION: readonly FitDrop[] = ['photo', 'atmosphere'];
const BLOCKS: readonly FitDrop[] = ['extras', 'chores'];

/** Every way to leave out `k` of `items`, the later ones (lower priority) first. */
function leaveOut(items: readonly number[], k: number): number[][] {
	if (k === 0) return [[]];
	if (k > items.length) return [];
	const out: number[][] = [];
	const pick = (start: number, chosen: number[]) => {
		if (chosen.length === k) {
			out.push(chosen);
			return;
		}
		for (let i = start; i < items.length; i++) pick(i + 1, [...chosen, items[i] as number]);
	};
	pick(0, []);
	// Leaving out the last widgets keeps those the family ordered first.
	return out.sort((a, b) => b.reduce((s, i) => s + i, 0) - a.reduce((s, i) => s + i, 0));
}

/**
 * The plans, in the order they are tried: each gives up a little more than the one before. First
 * fewer things per person, then the decoration (the photo, the weather's hours), then fewer rows
 * in each widget, then the granted blocks with the least to say (the extras, the chores), then a
 * little less zoom, and only when even the smallest type cannot hold them the widgets one by one,
 * and last everyone's status. Each is tried as it is, then with the style's widgets and smaller
 * blocks moved where there is room (`shift`).
 */
export function fitPlans(widgets: readonly number[], zoom: number): FitPlan[] {
	const out: Omit<FitPlan, 'shift'>[] = [];
	const plan = (p: Partial<Omit<FitPlan, 'shift'>>) =>
		out.push({ tight: 0, rows: 0, drop: [], hide: [], zoom, ...p });
	for (const tight of [0, 1, 2]) plan({ tight });
	const drop: FitDrop[] = [];
	for (const d of DECORATION) {
		drop.push(d);
		plan({ tight: 2, drop: [...drop] });
	}
	for (const rows of [1, 2, 3]) plan({ tight: 2, rows, drop: [...drop] });
	for (const d of BLOCKS) {
		drop.push(d);
		plan({ tight: 3, rows: 3, drop: [...drop] });
	}
	let smallest = zoom;
	for (let z = zoom - ZOOM_STEP; z >= 1 - 1e-6; z -= ZOOM_STEP) {
		smallest = z;
		plan({ tight: 3, rows: 3, drop: [...drop], zoom: z });
	}
	for (let k = 1; k <= widgets.length; k++)
		for (const hide of leaveOut(widgets, k))
			plan({ tight: 3, rows: 3, drop: [...drop], hide, zoom: smallest });
	plan({ tight: 3, rows: 3, drop: [...drop, 'family'], hide: [...widgets], zoom: smallest });
	return out.flatMap((p) => [
		{ ...p, shift: false },
		{ ...p, shift: true },
	]);
}

/**
 * What a plan that fits may take back, most valued first: the widgets, everyone's status, the
 * chores, the extras, widget rows, the weather's hours, the photo, things per person. Each as
 * the plan has it, then with the widgets moved (what came back may leave room elsewhere).
 */
function* giveBack(plan: FitPlan): Generator<FitPlan> {
	for (const next of eachGiveBack(plan)) {
		yield next;
		yield { ...next, shift: !next.shift };
	}
}

function* eachGiveBack(plan: FitPlan): Generator<FitPlan> {
	for (const i of plan.hide) yield { ...plan, hide: plan.hide.filter((h) => h !== i) };
	for (const d of ['family', 'chores', 'extras'] as const)
		if (plan.drop.includes(d)) yield { ...plan, drop: plan.drop.filter((x) => x !== d) };
	for (let rows = plan.rows - 1; rows >= 0; rows--) yield { ...plan, rows };
	for (const d of ['atmosphere', 'photo'] as const)
		if (plan.drop.includes(d)) yield { ...plan, drop: plan.drop.filter((x) => x !== d) };
	for (let tight = plan.tight - 1; tight >= 0; tight--) yield { ...plan, tight };
}

/**
 * The first plan that fits (else the last, which gives up the most), then everything it gave up
 * that still fits taken back, one thing at a time.
 */
export function chooseFit(
	widgets: readonly number[],
	zoom: number,
	fits: (plan: FitPlan) => boolean,
): FitPlan {
	const plans = fitPlans(widgets, zoom);
	let pick = plans.find((plan) => fits(plan));
	if (!pick) return plans.at(-1) as FitPlan;
	// Each step starts again from what was taken back so far, so it only ever gives back more.
	for (let again = true; again; ) {
		again = false;
		for (const next of giveBack(pick)) {
			if (!fits(next)) continue;
			pick = next;
			again = true;
			break;
		}
	}
	return pick;
}

/** The plan as `data-fit`, for tests and for reading a screenshot. */
export const describeFit = (plan: FitPlan): string =>
	[plan.tight, plan.drop.join(','), plan.rows, plan.hide.join(','), plan.zoom]
		.join('|')
		.concat(plan.shift ? '|shift' : '');

/**
 * What a family would miss on this display: the widgets the plan leaves out (by id), and the
 * groups of blocks it leaves out that had something to show (`present`). The weather's hours
 * are not counted: the weather itself stays.
 */
export function leftOut(
	plan: FitPlan,
	widgetIds: readonly string[],
	present: ReadonlySet<FitDrop>,
): string[] {
	return [
		...plan.hide.flatMap((i) => (widgetIds[i] ? [widgetIds[i]] : [])),
		...(['family', 'chores', 'extras', 'photo'] as const).filter(
			(d) => plan.drop.includes(d) && present.has(d),
		),
	];
}
