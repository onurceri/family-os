<script lang="ts">
	import { Avatar, formatClock, type TodayFormat } from '@famos/ui/famos';
	import {
		type Axis,
		foldedScale,
		hasTimed,
		type LaneItem,
		type LaneView,
		layoutColumn,
		MIN_BLOCK_HEIGHT,
	} from '../chart.js';

	/**
	 * Lanes' chart on a phone: the chart turns, with the
	 * time running down and one column per person, like a week view whose columns are people (at
	 * most five, then "Others", then the family when it has something). The axis folds: hours
	 * with nothing in them, two or more in a row, shrink to a hatched gap, so the day's things get
	 * the height. A block keeps its column's whole width and room for two lines of its title; one
	 * that overlaps the block above it moves below it. All-day things are chips under the names,
	 * not blocks. The now-line crosses every column. It is a chart, not a scroll: it always fits
	 * the width. A day with nothing timed draws only the heads (and the all-day chips): a frame of
	 * hatched, empty columns would carry no news and read as content.
	 */
	let {
		lanes,
		axis,
		now,
		nowMinute,
		nextId,
		format,
		label,
		blockName,
	}: {
		lanes: readonly LaneView[];
		axis: Axis;
		now: number;
		nowMinute: number | null;
		nextId: string | null;
		format: TodayFormat;
		label: string;
		blockName: (item: LaneItem) => string;
	} = $props();

	/** Five columns or more: the names alone, under the colour, so each column keeps its width. */
	const avatars = $derived(lanes.length <= 4);
	/** Six columns: the titles narrower still, so a word keeps to one line. */
	const narrow = $derived(lanes.length >= 6);
	const hourFormat = $derived(
		// "07:00", or "7 AM" on a 12-hour clock: a bare "07" does not read as a time.
		new Intl.DateTimeFormat(format.dateLocale, {
			hour: format.hourCycle === 'h12' ? 'numeric' : '2-digit',
			...(format.hourCycle === 'h12' ? {} : { minute: '2-digit' }),
			timeZone: 'UTC',
			hourCycle: format.hourCycle,
		}),
	);
	const hourLabel = (minute: number) =>
		hourFormat.format(Date.UTC(2026, 0, 1, Math.floor(minute / 60) % 24));

	const timedOf = (lane: LaneView) => lane.items.filter((c) => c.kind !== 'allday');
	const timed = $derived(hasTimed(lanes));
	const long = $derived(
		new Set(lanes.flatMap((l) => l.items.filter((c) => c.kind === 'long').map((c) => c.item.id))),
	);

	/* A block is as tall as its title needs: the title is measured in the block's own font. */
	let columnWidth = $state(0);
	let probe = $state<HTMLElement>();
	let fontsReady = $state(false);
	$effect(() => {
		void document.fonts?.ready.then(() => (fontsReady = true));
	});
	const measure = $derived.by(() => {
		if (!probe || !fontsReady) return null;
		const style = getComputedStyle(probe);
		const ctx = document.createElement('canvas').getContext('2d');
		if (!ctx) return null;
		ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		ctx.fontStretch = narrow ? 'extra-condensed' : 'condensed';
		return (text: string) => ctx.measureText(text).width;
	});
	/** How many lines a title takes in a column, words wrapping, a word too long breaking. */
	function linesFor(title: string): number {
		const room = columnWidth - (narrow ? 6 : 8);
		if (!measure || room <= 0) return 2;
		const space = measure(' ');
		let lines = 1;
		let used = 0;
		for (const word of title.split(/\s+/).filter(Boolean)) {
			const w = measure(word);
			if (used > 0 && used + space + w <= room) {
				used += space + w;
				continue;
			}
			if (used > 0) lines++;
			lines += Math.ceil(w / room) - 1;
			used = w - (Math.ceil(w / room) - 1) * room;
		}
		return Math.min(lines, 5);
	}
	const titles = $derived(
		new Map(lanes.flatMap((l) => l.items.map((c) => [c.item.id, c.item.title] as const))),
	);
	const minOf = $derived.by(() => {
		// The heights are measured lazily, inside the function below, which a derived does not
		// track: read what they depend on here so the cache starts over once the fonts have loaded
		// or the columns change width. A stale height clipped the title's last line mid-glyph.
		void measure;
		void columnWidth;
		void titles;
		const cache = new Map<string, number>();
		return (id: string) => {
			let h = cache.get(id);
			if (h === undefined) {
				h = Math.max(MIN_BLOCK_HEIGHT, linesFor(titles.get(id) ?? '') * 15 + 11);
				cache.set(id, h);
			}
			return h;
		};
	});
	const scale = $derived(
		foldedScale(
			lanes.map((l) => timedOf(l).map((c) => c.span)),
			axis,
			{ keep: [nowMinute], long, minPx: minOf },
		),
	);
	const columns = $derived(
		lanes.map((lane) => {
			const items = timedOf(lane);
			return {
				lane,
				items,
				blocks: layoutColumn(
					items.map((c) => c.span),
					scale,
					minOf,
					long,
				),
			};
		}),
	);
	/** The columns are as tall as the axis, or as the last block moved below another. */
	const height = $derived(
		Math.max(
			scale.height,
			...columns.flatMap((c) => c.blocks.map((b) => (b ? b.top + b.height : 0))),
		),
	);
	const nowAt = $derived(
		nowMinute === null || nowMinute < axis.from || nowMinute > axis.to ? null : scale.y(nowMinute),
	);
	/** A mark at the top of every drawn hour and every fold, and one at the end of the axis. */
	const marks = $derived([
		...scale.segments.map((s) => ({ minute: s.from, top: s.top })),
		{ minute: axis.to, top: scale.height },
	]);
	/** All-day things, once each, in the order of the columns. */
	const allDay = $derived.by(() => {
		const seen = new Set<string>();
		const out: LaneItem[] = [];
		for (const lane of lanes)
			for (const c of lane.items)
				if (c.kind === 'allday' && !seen.has(c.item.id)) {
					seen.add(c.item.id);
					out.push(c);
				}
		return out;
	});
	const isEnded = (c: LaneItem) => nowMinute !== null && (c.item.end ?? c.item.start ?? 0) <= now;
</script>

<div
	class="vchart"
	class:narrow
	style:--cols={lanes.length}
	role="group"
	aria-label={label}
	data-testid="day-chart-vertical"
>
	<div><span class="tt probe" bind:this={probe} aria-hidden="true"></span></div>
	{#each lanes as lane (lane.key)}
		<div class="mh" class:bare={!avatars} style:--m={lane.color || 'var(--ink-soft)'}>
			{#if lane.kind === 'others'}
				<span class="disc" aria-hidden="true">+{lane.people}</span>
			{:else if avatars}
				<Avatar name={lane.name} color={lane.color || 'var(--ink-soft)'} size={24} />
			{/if}
			<b title={lane.name}>{lane.short ?? lane.name}</b>
		</div>
	{/each}

	{#if allDay.length > 0}
		<ul class="ad">
			{#each allDay as c (c.item.id)}
				<li>
					<svelte:element
						this={c.item.href ? 'a' : 'div'}
						href={c.item.href || undefined}
						role={c.item.href ? undefined : 'img'}
						class="adc"
						style:--m={c.color || 'var(--ink-soft)'}
						aria-label={blockName(c)}
						data-testid="chart-block"
						><i aria-hidden="true"></i><span>{c.item.title}</span></svelte:element
					>
				</li>
			{/each}
		</ul>
	{/if}

	{#if timed}
		<div class="vax" style:height="{height}px" aria-hidden="true">
			{#each marks as m (m.minute)}
				<!-- The now-tag takes the place of a mark it would cover. -->
				{#if nowAt === null || Math.abs(m.top - nowAt) >= 14}
					<span style:top="{m.top}px">{hourLabel(m.minute)}</span>
				{/if}
			{/each}
			{#if nowAt !== null}
				<span class="nowtag" style:top="{nowAt}px" data-testid="now-tag"
					>{formatClock(now, format)}</span
				>
			{/if}
		</div>
		{#each columns as { lane, items, blocks }, ci (lane.key)}
			<div class="vlane" style:height="{height}px" role="group" aria-label={lane.name}>
				{#if ci === 0}<span class="width" bind:clientWidth={columnWidth} aria-hidden="true"
					></span>{/if}
				{#each scale.segments as s (s.from)}
					<span
						class="seg"
						class:gap={s.gap}
						style:top="{s.top}px"
						style:height="{s.height}px"
						aria-hidden="true"
					></span>
				{/each}
				{#each items as c, i (c.item.id)}
					{@const b = blocks[i]}
					{#if b}
						<svelte:element
							this={c.item.href ? 'a' : 'div'}
							href={c.item.href || undefined}
							role={c.item.href ? undefined : 'img'}
							class="vblk {c.kind}"
							class:past={isEnded(c)}
							class:next={c.item.id === nextId}
							style:--m={c.color || 'var(--ink-soft)'}
							style:--lines={Math.max(2, linesFor(c.item.title))}
							style:top="{b.top}px"
							style:height="{b.height}px"
							aria-label={blockName(c)}
							data-testid="chart-block"
							><span class="tt">{c.item.title}</span
							>{#if b.height >= minOf(c.item.id) + 14 && c.item.start !== undefined}<small
									>{formatClock(c.item.start, format)}</small
								>{/if}</svelte:element
						>
					{/if}
				{/each}
				{#if nowAt !== null}
					<span class="vnow" style:top="{nowAt}px" aria-hidden="true"></span>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<style>
	.vchart {
		display: grid;
		grid-template-columns: 2.125rem repeat(var(--cols), minmax(0, 1fr));
		gap: 0 3px;
		min-width: 0;
	}
	.mh {
		display: grid;
		justify-items: center;
		gap: 4px;
		min-width: 0;
		margin-bottom: 6px;
		padding-bottom: 7px;
		border-bottom: 3px solid var(--m);
	}
	.mh.bare {
		align-content: end;
	}
	.mh b {
		max-width: 100%;
		overflow: hidden;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
	}
	.disc {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--idle);
		color: var(--ink);
		font-size: 10px;
		font-weight: 800;
	}
	.mh.bare .disc {
		width: auto;
		height: auto;
		padding: 1px 6px;
	}
	/* All-day things: chips across the chart, under the names. */
	.ad {
		display: flex;
		grid-column: 1 / -1;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0 0 10px;
		padding: 0;
		list-style: none;
	}
	.ad li {
		min-width: 0;
		max-width: 100%;
	}
	.adc {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		min-height: 28px;
		padding: 0 10px 0 8px;
		border: 1px dashed var(--m);
		border-radius: 999px;
		color: var(--ink);
		font-size: 12.5px;
		font-weight: 700;
		text-decoration: none;
	}
	.adc i {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--m);
	}
	.adc span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.vax {
		position: relative;
	}
	.vax span {
		position: absolute;
		left: 0;
		transform: translateY(-50%);
		font-size: 10px;
		font-weight: 700;
		color: var(--ink-soft);
		white-space: nowrap;
	}
	.vax .nowtag {
		z-index: 3;
		padding: 1px 5px;
		border-radius: 999px;
		background: var(--now);
		color: var(--on-color);
		font-size: 9px;
		font-weight: 800;
	}
	.vlane {
		position: relative;
		min-width: 0;
		border-bottom: 1px solid var(--line);
	}
	.seg {
		position: absolute;
		right: 0;
		left: 0;
		border-top: 1px solid var(--line);
	}
	/* Folded hours: a hatched strip, so the jump in time shows. */
	.seg.gap {
		background: repeating-linear-gradient(-45deg, var(--line) 0 1px, transparent 1px 6px);
	}
	.vblk {
		position: absolute;
		right: 0;
		left: 0;
		z-index: 1;
		display: grid;
		align-content: start;
		gap: 1px;
		padding: 3px 4px 4px;
		overflow: hidden;
		border-top: 3px solid var(--m);
		border-radius: 7px;
		background: color-mix(in oklab, var(--m) 16%, var(--surface));
		color: var(--ink);
		text-decoration: none;
	}
	/* The display face, condensed, so two lines hold a title in a narrow column. */
	.tt {
		display: -webkit-box;
		overflow: hidden;
		font-family: var(--font-family-display, var(--style-font-display, var(--font-family)));
		font-size: 13px;
		font-weight: 700;
		font-stretch: condensed;
		line-height: 15px;
		overflow-wrap: anywhere;
		hyphens: auto;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: var(--lines);
		line-clamp: var(--lines);
	}
	.narrow .tt {
		font-stretch: extra-condensed;
	}
	.narrow {
		gap: 0 2px;
	}
	.narrow .vblk {
		padding-inline: 3px;
	}
	/* What the titles are measured with, and the column's width. */
	.probe,
	.width {
		position: absolute;
		visibility: hidden;
		pointer-events: none;
	}
	.width {
		right: 0;
		left: 0;
		height: 0;
	}
	.vblk small {
		font-size: 10.5px;
		font-weight: 600;
		color: var(--ink-soft);
	}
	.vblk:focus-visible {
		z-index: 3;
		outline: 2px solid var(--ink);
		outline-offset: 1px;
	}
	.past {
		opacity: 0.5;
	}
	.next {
		background: var(--surface);
		box-shadow: 0 0 0 2px var(--accent);
	}
	.meal {
		border-top-color: var(--ink-soft);
		background: var(--idle);
	}
	.long {
		z-index: 0;
		border-top-style: dashed;
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.vnow {
		position: absolute;
		right: -2px;
		left: -2px;
		z-index: 2;
		height: 2px;
		margin-top: -1px;
		background: var(--now);
		pointer-events: none;
	}
</style>
