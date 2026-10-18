/** Overlap layout of one day's timed events on the hour grid. */

export interface Span {
	id: string;
	/** Minutes from the start of the day, 0 to 1440. */
	start: number;
	end: number;
}

export interface Placed {
	id: string;
	/** Zero-based column inside its cluster; earlier starts sit further left. */
	column: number;
	/** How many columns the cluster is drawn in: a chip is `span`/columns of the day's width. */
	columns: number;
	/** How many columns the chip covers: it widens into free columns to its right. */
	span: number;
	/** Cluster the chip belongs to (for `overflowOf`). */
	cluster: number;
	/** True when the cluster has more columns than fit; the chip is counted in "+N more" instead. */
	hidden: boolean;
}

/** The "+N more" chip of a crowded cluster: where it sits and how many events it stands for. */
export interface Overflow {
	cluster: number;
	column: number;
	columns: number;
	/** Minutes from the start of the day, covering the events it stands for. */
	start: number;
	end: number;
	count: number;
}

/** A chip is never drawn shorter than this, so it counts as this long when finding overlaps. */
export const MIN_SPAN = 30;

/** The narrowest a chip may be drawn, in px: titles are unreadable below it. */
export const MIN_CHIP_WIDTH = 56;

/**
 * How many side-by-side lanes a day column of this measured width can hold, each at least
 * `MIN_CHIP_WIDTH` wide (at most six). A column too narrow for two lanes holds one, so an
 * overlapping cluster there shows only its "+N more" chip instead of slivers nobody can read.
 * Before the width is known (zero) nothing is held back.
 */
export const maxColumnsFor = (width: number): number =>
	width > 0 ? Math.max(1, Math.min(6, Math.floor(width / MIN_CHIP_WIDTH))) : 6;

/**
 * Clusters events whose times intersect and gives each a column, greedily: the first column whose
 * last event has ended. Back-to-back events (one ends when the next starts) do not overlap.
 * A chip then widens into the free columns to its right, so a lone event beside a busy hour is not
 * a sliver. When a cluster needs more than `maxColumns` columns, the last visible column is kept for
 * a "+N more" chip (see `overflowOf`) and the events that would sit in it or beyond are `hidden`.
 * The result keeps the order of the input.
 */
export function layoutDay(
	spans: readonly Span[],
	minSpan = MIN_SPAN,
	maxColumns = Number.POSITIVE_INFINITY,
): Placed[] {
	const effective = (s: Span) => Math.max(s.end, s.start + minSpan);
	const order = spans
		.map((span, index) => ({ span, index }))
		.sort(
			(a, b) =>
				a.span.start - b.span.start || effective(b.span) - effective(a.span) || a.index - b.index,
		);
	const placed = new Map<string, Placed>();
	let cluster: { p: Placed; start: number; end: number }[] = [];
	let clusterEnd = Number.NEGATIVE_INFINITY;
	let columnEnds: number[] = [];
	let clusterId = 0;

	const close = () => {
		if (cluster.length === 0) return;
		const needed = columnEnds.length;
		const crowded = needed > maxColumns;
		const columns = crowded ? maxColumns : needed;
		// A crowded cluster keeps its last visible column for the "+N more" chip.
		const room = crowded ? maxColumns - 1 : needed;
		for (const item of cluster) {
			const p = item.p;
			p.columns = columns;
			p.hidden = crowded && p.column >= room;
			if (p.hidden) continue;
			let span = 1;
			while (
				p.column + span < room &&
				!cluster.some(
					(o) =>
						o !== item &&
						o.p.column === p.column + span &&
						o.start < item.end &&
						o.end > item.start,
				)
			)
				span++;
			p.span = span;
		}
		cluster = [];
		columnEnds = [];
		clusterId++;
	};

	for (const { span } of order) {
		if (span.start >= clusterEnd) close();
		let column = columnEnds.findIndex((end) => end <= span.start);
		if (column === -1) column = columnEnds.length;
		columnEnds[column] = effective(span);
		clusterEnd = cluster.length ? Math.max(clusterEnd, effective(span)) : effective(span);
		const p: Placed = {
			id: span.id,
			column,
			columns: 1,
			span: 1,
			cluster: clusterId,
			hidden: false,
		};
		cluster.push({ p, start: span.start, end: effective(span) });
		placed.set(span.id, p);
	}
	close();
	return spans.map((s) => placed.get(s.id) as Placed);
}

/** The "+N more" chips of the clusters that did not fit, one per cluster. */
export function overflowOf(
	spans: readonly Span[],
	placed: readonly Placed[],
	minSpan = MIN_SPAN,
): Overflow[] {
	const out = new Map<number, Overflow>();
	spans.forEach((s, i) => {
		const p = placed[i];
		if (!p?.hidden) return;
		const end = Math.max(s.end, s.start + minSpan);
		const found = out.get(p.cluster);
		if (found) {
			found.start = Math.min(found.start, s.start);
			found.end = Math.max(found.end, end);
			found.count++;
		} else {
			out.set(p.cluster, {
				cluster: p.cluster,
				column: p.columns - 1,
				columns: p.columns,
				start: s.start,
				end,
				count: 1,
			});
		}
	});
	return [...out.values()];
}

/**
 * The part of a timed event that falls on one day, in minutes from that day's start, or null when
 * it does not touch the day. `dayStart` and `dayEnd` are the day's bounds in epoch ms; `minutesOf`
 * turns an instant inside the day into minutes (the caller knows the time zone, so a day with a
 * clock change stays right). An event crossing midnight ends at 1440 on its first day and starts at
 * 0 on the next.
 */
export function clipToDay(
	start: number,
	end: number,
	dayStart: number,
	dayEnd: number,
	minutesOf: (at: number) => number,
): { start: number; end: number } | null {
	if (start >= dayEnd || end <= dayStart) return null;
	return {
		start: start <= dayStart ? 0 : minutesOf(start),
		end: end >= dayEnd ? 1440 : minutesOf(end),
	};
}

/** Pixels per hour: at least 44, otherwise 1/14 of the visible body so about 13 hours fit. */
export const hourHeight = (bodyHeight: number): number => Math.max(44, Math.floor(bodyHeight / 14));

/** The room above the first fitted hour, so its label is not cut in half. */
export const FIT_LEAD = 10;

/**
 * The hours a fitted board shows: 07:00 to 22:00, widened to the earliest start and the latest end
 * of the events (minutes from the start of the day), never beyond the day.
 */
export function fitWindow(spans: readonly { start: number; end: number }[]): {
	from: number;
	to: number;
} {
	let from = 7;
	let to = 22;
	for (const s of spans) {
		from = Math.min(from, Math.floor(s.start / 60));
		to = Math.max(to, Math.ceil(s.end / 60));
	}
	return { from: Math.max(0, from), to: Math.min(24, to) };
}

/** Pixels per hour so that the window fills a body `bodyHeight` tall (never under 20). */
export const fitHour = (bodyHeight: number, window: { from: number; to: number }): number =>
	Math.max(20, Math.floor((bodyHeight - FIT_LEAD) / (window.to - window.from)));

/**
 * The box of an event block on the hour grid, in px: its border, its padding (`tight` when the
 * normal padding would cut a line), and the line heights of the title and of the lines under it. The block's CSS
 * uses these numbers, so what `blockFit` decides is what the browser draws.
 */
export const BLOCK = { border: 1, pad: 4, tight: 2, title: 16, meta: 14 } as const;

/** The shortest block: one whole title line inside the tight padding (22 px, 30 minutes at the smallest hour). */
export const MIN_BLOCK_HEIGHT = 2 * BLOCK.border + 2 * BLOCK.tight + BLOCK.title;

/**
 * The height of a block for `minutes` at `hour` px per hour, 1 px short so back-to-back events
 * keep a seam, and never below one title line: a 15-minute event still shows its title whole,
 * starting at its start time and reaching a little past its end.
 */
export const blockHeight = (minutes: number, hour: number): number =>
	Math.max(MIN_BLOCK_HEIGHT, (minutes / 60) * hour - 1);

export interface BlockFit {
	/** 1: one line with an ellipsis; 2: the title wraps once, then an ellipsis. */
	titleLines: 1 | 2;
	/** How many of the wanted lines under the title fit whole. */
	metaLines: number;
	/** The padding shrinks to `BLOCK.tight`, because only then does the title or its next line fit. */
	tight: boolean;
}

/**
 * What a block `height` px tall shows when it would like `wanted` lines under its title: the title
 * always; each line under it only when it fits whole; a second title line with the room left. A
 * title that does not fit on one line (`titleWraps`) takes the second line before anything under
 * it does: the block's place on the grid already says when it is, and a title read whole says
 * more than a title cut short above a time. A line is never cut through: the lines chosen plus
 * padding and border are never taller than the block.
 */
export function blockFit(height: number, wanted: number, titleWraps = false): BlockFit {
	const within = (pad: number) => {
		const inner = height - 2 * BLOCK.border - 2 * pad;
		if (titleWraps && inner >= 2 * BLOCK.title) {
			const metaLines = Math.max(
				0,
				Math.min(wanted, Math.floor((inner - 2 * BLOCK.title) / BLOCK.meta)),
			);
			return { titleLines: 2 as const, metaLines, inner };
		}
		const room = Math.floor((inner - BLOCK.title) / BLOCK.meta);
		const metaLines = Math.max(0, Math.min(wanted, room));
		const titleLines: 1 | 2 = inner - metaLines * BLOCK.meta >= 2 * BLOCK.title ? 2 : 1;
		return { titleLines, metaLines, inner };
	};
	const roomy = within(BLOCK.pad);
	const tight = within(BLOCK.tight);
	// The thin padding only when it is what lets a line fit whole.
	const lines = (f: { titleLines: number; metaLines: number }) => f.titleLines + f.metaLines;
	if (roomy.inner >= BLOCK.title && lines(roomy) >= lines(tight))
		return { titleLines: roomy.titleLines, metaLines: roomy.metaLines, tight: false };
	return { titleLines: tight.titleLines, metaLines: tight.metaLines, tight: true };
}

/** The first hour to show when a week opens: 07:00, or an hour before the first event if earlier. */
export function firstVisibleHour(earliestStartMinutes: number | null): number {
	if (earliestStartMinutes === null) return 7;
	return Math.max(0, Math.min(7, Math.floor(earliestStartMinutes / 60) - 1));
}

/** Rows that fit in a month cell: `floor((cellHeight − 36) / 23)`, at least 1. */
export const monthRows = (cellHeight: number): number =>
	Math.max(1, Math.floor((cellHeight - 36) / 23));

/** Rounds a minute of the day down to a 30-minute slot. */
export const snapSlot = (minutes: number): number => Math.min(1410, Math.floor(minutes / 30) * 30);

/** A stretch of six hours or more (someone at work): drawn hollow, behind the day's other events. */
export const isLongBlock = (start: number, end: number): boolean => end - start >= 6 * 3_600_000;
