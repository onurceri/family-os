import { dayBounds, zoned } from '@famos/time';
import type { TimelineItem } from '@famos/ui/slots';
import { groupOf, sortTimeline } from '@famos/ui/timeline';

/**
 * The layout of Lanes' day chart: one time axis, a lane per person and one for the family, blocks where things happen.
 * Pure: minutes of the day and pixels in, positions out. The components only draw them.
 */

/** A stretch of the day in minutes from its start (0 to 1440). */
export interface Axis {
	from: number;
	to: number;
}

/** 07:00 to 22:00, widened to whole hours when something on the day falls outside it. */
export const AXIS: Axis = { from: 7 * 60, to: 22 * 60 };
/** A block is never narrower than this, so its title can be read; capped at the axis end. */
export const MIN_BLOCK_PX = 112;
/** A lane grows to two rows at most when its blocks overlap. */
export const MAX_ROWS = 2;
/** At most six person lanes on the wide chart, then one "Others" lane. */
export const MAX_LANES = 6;
/** At most five person columns on the phone's chart, then one "Others" column. */
export const MAX_COLUMNS = 5;
/** A stretch of six hours or more (someone at work) is drawn hollow, behind the lane's blocks. */
export const LONG_MINUTES = 6 * 60;

export interface Span {
	id: string;
	/** Minutes from the start of the day. */
	start: number;
	end: number;
}

/* ───────────── the axis ───────────── */

/** The axis that holds every span: `base`, widened to the whole hours around anything outside. */
export function axisFor(spans: readonly Span[], base: Axis = AXIS): Axis {
	let { from, to } = base;
	for (const s of spans) {
		from = Math.min(from, Math.floor(s.start / 60) * 60);
		to = Math.max(to, Math.ceil(Math.max(s.end, s.start) / 60) * 60);
	}
	return { from: Math.max(0, from), to: Math.min(1440, to) };
}

/** The hours on the axis, from its first to its last mark (07, 08, … 22). */
export const hoursOf = (axis: Axis): number[] =>
	Array.from({ length: (axis.to - axis.from) / 60 + 1 }, (_, i) => axis.from / 60 + i);

/** Where a minute sits on the axis, 0 to 1 (clamped). */
export const fractionOf = (minute: number, axis: Axis): number =>
	Math.min(1, Math.max(0, (minute - axis.from) / (axis.to - axis.from)));

/** The now-line: where `minute` sits, or null when it is outside the axis. */
export const nowFraction = (minute: number | null, axis: Axis): number | null =>
	minute === null || minute < axis.from || minute > axis.to ? null : fractionOf(minute, axis);

/* ───────────── overlaps (the calendar's cluster layout) ───────────── */

interface Column {
	id: string;
	column: number;
	columns: number;
}

/**
 * Clusters spans whose times intersect and gives each a column, greedily: the first column whose
 * last span has ended. Back-to-back spans do not overlap. Copied from the calendar's hour grid
 * (extensions/calendar/src/web/layout.ts, `layoutDay`): the app cannot import an extension, and
 * the two charts must agree on what overlaps. Keeps the order of the input.
 */
export function clusterColumns(spans: readonly Span[]): Column[] {
	const order = spans
		.map((span, index) => ({ span, index }))
		.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end || a.index - b.index);
	const placed = new Map<string, Column>();
	let cluster: Column[] = [];
	let clusterEnd = Number.NEGATIVE_INFINITY;
	let columnEnds: number[] = [];
	const close = () => {
		for (const p of cluster) p.columns = columnEnds.length;
		cluster = [];
		columnEnds = [];
	};
	for (const { span } of order) {
		if (span.start >= clusterEnd) close();
		let column = columnEnds.findIndex((end) => end <= span.start);
		if (column === -1) column = columnEnds.length;
		columnEnds[column] = span.end;
		clusterEnd = cluster.length ? Math.max(clusterEnd, span.end) : span.end;
		const p: Column = { id: span.id, column, columns: 1 };
		cluster.push(p);
		placed.set(span.id, p);
	}
	close();
	return spans.map((s) => placed.get(s.id) as Column);
}

/* ───────────── a lane (the wide chart) ───────────── */

export interface Block {
	id: string;
	/** From the lane's start, in px. */
	left: number;
	width: number;
	/** Zero-based row inside the lane (overlaps stack, at most `MAX_ROWS`). */
	row: number;
}

/**
 * Places a lane's spans on an axis drawn `width` px wide: a block is as long as its span but at
 * least `minPx`, and never runs past the end of the axis. Blocks whose drawn extents overlap
 * stack in rows (a third overlap shares the last row).
 */
export function layoutLane(
	spans: readonly Span[],
	axis: Axis,
	width: number,
	minPx = MIN_BLOCK_PX,
	maxRows = MAX_ROWS,
): Block[] {
	const perMinute = width / (axis.to - axis.from);
	const drawn = spans.map((s) => {
		const start = Math.min(Math.max(s.start, axis.from), axis.to);
		const end = Math.min(Math.max(s.end, start), axis.to);
		const left = (start - axis.from) * perMinute;
		const room = (axis.to - start) * perMinute;
		const w = Math.min(Math.max((end - start) * perMinute, minPx), room);
		return { id: s.id, left, width: w, start, end: start + (perMinute > 0 ? w / perMinute : 0) };
	});
	const columns = clusterColumns(drawn);
	return drawn.map((d, i) => ({
		id: d.id,
		left: d.left,
		width: d.width,
		row: Math.min(columns[i]?.column ?? 0, maxRows - 1),
	}));
}

/** How many rows a lane needs (1 or 2). */
export const rowsOf = (blocks: readonly Block[]): number =>
	blocks.reduce((rows, b) => Math.max(rows, b.row + 1), 1);

/* ───────────── a column (the phone's chart) ───────────── */

/** A block on the phone's chart is never shorter than this: two lines of 13 px and the edge. */
export const MIN_BLOCK_HEIGHT = 44;
/** An hour on the phone's chart, in px (taller when a column has more blocks starting in it). */
export const HOUR_HEIGHT = 48;
/** Two or more empty hours in a row fold into a gap this tall on the phone's chart. */
export const GAP_HEIGHT = 22;

/** A block's minimum height in px: one for all, or one per span id (a longer title, more lines). */
export type MinHeight = number | ((id: string) => number);
const heightOf = (min: MinHeight, id: string) => (typeof min === 'number' ? min : min(id));

/** A stretch of the phone's axis: an hour drawn at its height, or a fold of empty hours. */
export interface Segment {
	/** Minutes from the start of the day. */
	from: number;
	to: number;
	gap: boolean;
	/** From the chart's top, in px. */
	top: number;
	height: number;
}

/** Where minutes sit on a vertical axis: `y` in px from the top, `height` in all. */
export interface Scale {
	segments: Segment[];
	height: number;
	y: (minute: number) => number;
}

function scaleOf(segments: Segment[]): Scale {
	const last = segments.at(-1);
	return {
		segments,
		height: last ? last.top + last.height : 0,
		y(minute) {
			const s = segments.find((seg) => minute < seg.to) ?? last;
			if (!s) return 0;
			const at = Math.min(Math.max(minute, s.from), s.to);
			return s.top + ((at - s.from) / (s.to - s.from)) * s.height;
		},
	};
}

/** A linear axis `height` px tall: every hour the same. */
export const linearScale = (axis: Axis, height: number): Scale =>
	scaleOf([{ from: axis.from, to: axis.to, gap: false, top: 0, height }]);

/**
 * The phone's axis, folded: an hour is drawn when something happens in it (a span's whole
 * length, only the first hour of a `long` one, or a minute in `keep` such as the now-line), and
 * runs of two or more empty hours fold into one short gap (a single empty hour is drawn at half
 * height), so an empty morning does not eat the screen. An hour where a column has several
 * blocks starting grows so they fit one below the other. `columns` holds each column's spans.
 */
export function foldedScale(
	columns: readonly (readonly Span[])[],
	axis: Axis,
	options: {
		keep?: readonly (number | null)[];
		long?: ReadonlySet<string>;
		hourHeight?: number;
		gapHeight?: number;
		minPx?: MinHeight;
	} = {},
): Scale {
	const {
		keep = [],
		long = new Set<string>(),
		hourHeight = HOUR_HEIGHT,
		gapHeight = GAP_HEIGHT,
		minPx = MIN_BLOCK_HEIGHT,
	} = options;
	const first = axis.from / 60;
	const count = (axis.to - axis.from) / 60;
	const busy = Array.from({ length: count }, () => false);
	const starts = Array.from({ length: count }, () => 0);
	const hourOf = (minute: number) =>
		Math.min(count - 1, Math.max(0, Math.floor(minute / 60) - first));
	for (const spans of columns) {
		const here = Array.from({ length: count }, () => 0);
		for (const s of spans) {
			if (s.end < axis.from || s.start >= axis.to) continue;
			const a = hourOf(s.start);
			if (!long.has(s.id)) here[a] = (here[a] ?? 0) + heightOf(minPx, s.id) + 2;
			const b = long.has(s.id) ? a : hourOf(Math.max(s.start, s.end - 1));
			for (let h = a; h <= b; h++) busy[h] = true;
		}
		for (let h = 0; h < count; h++) starts[h] = Math.max(starts[h] ?? 0, here[h] ?? 0);
	}
	for (const minute of keep)
		if (minute !== null && minute >= axis.from && minute <= axis.to) busy[hourOf(minute)] = true;
	// A block that runs past its hour at its minimum height keeps the next hour from folding.
	for (const spans of columns)
		for (const s of spans) {
			if (long.has(s.id) || s.end < axis.from || s.start >= axis.to) continue;
			const a = hourOf(s.start);
			const room = Math.max(hourHeight, starts[a] ?? 0);
			const at = ((s.start - (first + a) * 60) / 60) * room;
			if (at + heightOf(minPx, s.id) > room && a + 1 < count) busy[a + 1] = true;
		}

	const segments: Segment[] = [];
	let top = 0;
	let h = 0;
	while (h < count) {
		if (busy[h]) {
			const height = Math.max(hourHeight, starts[h] ?? 0);
			segments.push({ from: (first + h) * 60, to: (first + h + 1) * 60, gap: false, top, height });
			top += height;
			h++;
			continue;
		}
		let end = h;
		while (end < count && !busy[end]) end++;
		const gap = end - h >= 2;
		const height = gap ? gapHeight : hourHeight / 2;
		segments.push({ from: (first + h) * 60, to: (first + end) * 60, gap, top, height });
		top += height;
		h = end;
	}
	return scaleOf(segments);
}

export interface VerticalBlock {
	id: string;
	/** From the column's top, in px. */
	top: number;
	height: number;
}

/**
 * Places a column's spans on a vertical scale. A block is as tall as its span but at least
 * `minPx`; a block that would overlap the one above it moves down below it, so every block
 * keeps the column's whole width and its title can be read. Spans in `behind` (long, hollow
 * stretches) keep their place and never push a block. Keeps the order of the input.
 */
export function layoutColumn(
	spans: readonly Span[],
	scale: Scale,
	minPx: MinHeight = MIN_BLOCK_HEIGHT,
	behind: ReadonlySet<string> = new Set(),
): VerticalBlock[] {
	const placed = new Map<string, VerticalBlock>();
	let bottom = Number.NEGATIVE_INFINITY;
	const order = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
	for (const s of order) {
		const y = scale.y(s.start);
		const natural = scale.y(Math.max(s.end, s.start)) - y;
		if (behind.has(s.id)) {
			placed.set(s.id, { id: s.id, top: y, height: Math.max(natural, heightOf(minPx, s.id)) });
			continue;
		}
		const top = Math.max(y, bottom + 2);
		const height = Math.max(natural - (top - y), heightOf(minPx, s.id));
		placed.set(s.id, { id: s.id, top, height });
		bottom = top + height;
	}
	return spans.map((s) => placed.get(s.id) as VerticalBlock);
}

/* ───────────── lanes: who gets one ───────────── */

export interface LaneMember {
	id: string;
	displayName: string;
	/** What the lane's head shows (`withShortNames`); `displayName` stays its title. */
	shortName?: string;
	color: string;
}

export interface PersonLane<T> {
	member: LaneMember;
	items: T[];
}

export interface LanePlan<T> {
	/** One lane per person, in the family's order. */
	people: PersonLane<T>[];
	/** The people beyond `max`, in one lane (null when everyone has their own). */
	others: { members: LaneMember[]; items: T[] } | null;
	/** Items with no member (and meals): the family's lane. */
	family: T[];
}

/**
 * Who gets a lane: everyone when there are at most `max` people; otherwise `max` lanes go to the
 * people who have something on the day (in the family's order, then the rest), and the others
 * share one lane. An item with several people is in each of their lanes, once in "Others".
 */
export function planLanes<T>(
	members: readonly LaneMember[],
	items: readonly T[],
	max: number,
	membersOf: (item: T) => readonly string[],
): LanePlan<T> {
	const of = (id: string) => items.filter((item) => membersOf(item).includes(id));
	const family = items.filter((item) => membersOf(item).length === 0);
	if (members.length <= max)
		return { people: members.map((m) => ({ member: m, items: of(m.id) })), others: null, family };
	const ranked = [
		...members.filter((m) => of(m.id).length > 0),
		...members.filter((m) => of(m.id).length === 0),
	];
	const own = new Set(ranked.slice(0, max).map((m) => m.id));
	const rest = members.filter((m) => !own.has(m.id));
	const restIds = new Set(rest.map((m) => m.id));
	return {
		people: members.filter((m) => own.has(m.id)).map((m) => ({ member: m, items: of(m.id) })),
		others: {
			members: rest,
			items: items.filter((item) => membersOf(item).some((id) => restIds.has(id))),
		},
		family,
	};
}

/** The phone's chart never has more than this many columns (people, "Others" and the family). */
export const MAX_PHONE_COLUMNS = 6;

/**
 * How many people get a column of their own on the phone: everyone while the columns fit,
 * otherwise five (`MAX_COLUMNS`) or, when the family's column is shown too, four, so that with
 * "Others" the chart keeps at most `MAX_PHONE_COLUMNS` columns.
 */
export function phonePeople(people: number, familyColumn: boolean): number {
	const family = familyColumn ? 1 : 0;
	if (people + family <= MAX_PHONE_COLUMNS) return people;
	return Math.min(MAX_COLUMNS, MAX_PHONE_COLUMNS - 1 - family);
}

/* ───────────── the day's items as spans ───────────── */

/** What a chart draws for one timeline item. */
export type ChartKind = 'event' | 'meal' | 'long' | 'allday';

export interface ChartItem {
	item: TimelineItem;
	kind: ChartKind;
	span: Span;
}

/** A meal plan's slot has a nominal time and no end: it is drawn an hour long. */
const MEAL_MINUTES = 60;
const TIMED = 1;
const ALL_DAY = 0;

/** Minutes from the start of `day` (YYYY-MM-DD) in `timeZone`, clipped to the day. */
export function minutesInDay(at: number, day: string, timeZone: string): number {
	const { start, end } = dayBounds(day, timeZone);
	if (at <= start) return 0;
	if (at >= end) return 1440;
	const z = zoned(at, timeZone);
	return z.hour * 60 + z.minute;
}

/**
 * The day's items as the chart draws them: timed events (a stretch of six hours or more is
 * `long`, hollow), meals as idle blocks at their nominal time, all-day items across the whole
 * axis (hollow, behind). Chores and untimed tasks are not on the chart (the bars carry chores).
 */
export function chartItems(
	items: readonly TimelineItem[],
	day: string,
	timeZone: string,
): ChartItem[] {
	const out: ChartItem[] = [];
	for (const item of sortTimeline(items)) {
		if (item.kind === 'chore') continue;
		const group = groupOf(item);
		if (group === ALL_DAY) {
			if (item.kind !== 'meal')
				out.push({ item, kind: 'allday', span: { id: item.id, start: 0, end: 1440 } });
			continue;
		}
		if (group !== TIMED || item.start === undefined) continue;
		const start = minutesInDay(item.start, day, timeZone);
		if (item.kind === 'meal' || item.nominal) {
			if (item.kind === 'meal')
				out.push({
					item,
					kind: 'meal',
					span: { id: item.id, start, end: Math.min(1440, start + MEAL_MINUTES) },
				});
			continue;
		}
		const end = Math.max(start, minutesInDay(item.end ?? item.start, day, timeZone));
		out.push({
			item,
			kind: end - start >= LONG_MINUTES ? 'long' : 'event',
			span: { id: item.id, start, end },
		});
	}
	return out;
}

/* ───────────── what the components draw ───────────── */

/** A chart item with the colour its block takes (the member's; empty for the family). */
export interface LaneItem extends ChartItem {
	color: string;
}

/**
 * Whether any lane has something with a time. Without one, the phone's chart is only empty,
 * folded columns under a quiet sentence that already says so, so it draws the heads alone.
 */
export const hasTimed = (lanes: readonly { items: readonly { kind: ChartKind }[] }[]): boolean =>
	lanes.some((lane) => lane.items.some((c) => c.kind !== 'allday'));

/** One lane of the wide chart, or one column of the phone's. */
export interface LaneView {
	key: string;
	kind: 'person' | 'others' | 'family';
	name: string;
	/** What the head shows when shorter than `name` (a person's first name). */
	short?: string;
	/** The member's colour; empty for "Others" and the family. */
	color: string;
	/** One clause under the name (the person's status, who is in "Others"). */
	status: string;
	/** How many people "Others" holds (1 for a person or the family). */
	people: number;
	items: LaneItem[];
	/** Their chores today, folded into the lane's head (on a display). */
	chores?: { done: number; total: number; color?: string; name: string };
}
