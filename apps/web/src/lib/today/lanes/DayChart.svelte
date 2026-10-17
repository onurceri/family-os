<script lang="ts">
	import { Avatar, formatClock, type HourlyPoint, Ring, type TodayFormat } from '@famos/ui/famos';
	import {
		type Axis,
		fractionOf,
		hoursOf,
		type LaneItem,
		type LaneView,
		layoutLane,
		MAX_ROWS,
		MIN_BLOCK_PX,
		nowFraction,
		rowsOf,
	} from '../chart.js';
	import WeatherRow from './WeatherRow.svelte';

	/**
	 * Lanes' day as a chart: one time axis across the
	 * page, the hourly weather on it, a lane per person (then "Others", then the family) with the
	 * day's things as blocks where they happen, and the now-line across every lane. A block is a
	 * 16 % tint of its member's colour behind `ink` text with a 3 px edge in the colour; past
	 * blocks fade, the next one has an `accent` ring, meals are `idle`, all-day and long stretches
	 * are hollow behind the rest. Positions come from `chart.ts`; the track is measured so a block
	 * keeps its minimum width in pixels.
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
		weather = null,
		quiet = null,
		maxRows = MAX_ROWS,
		allDayRow = false,
	}: {
		lanes: readonly LaneView[];
		axis: Axis;
		now: number;
		/** Minutes into the day now; null when the chart shows another day (the evening). */
		nowMinute: number | null;
		nextId: string | null;
		format: TodayFormat;
		/** The chart's accessible name. */
		label: string;
		/** A block's accessible name: "Piano lesson, 15:45" (or "…, all day"). */
		blockName: (item: LaneItem) => string;
		weather?: {
			label: string;
			range: string;
			hours: readonly HourlyPoint[];
			day: string;
			condition?: (code: number) => string;
		} | null;
		/** A day with nothing on the chart: the quiet sentence, written across the empty lanes. */
		quiet?: { title: string; text: string } | null;
		/** Rows a lane may grow to when its blocks overlap (one lane for everyone needs more). */
		maxRows?: number;
		/** All-day stretches get a row each above the timed blocks instead of lying behind them. */
		allDayRow?: boolean;
	} = $props();

	/** A lone lane (names off) is as tall as two, so the quiet sentence written across it fits. */
	const QUIET_ROWS = 2;
	/** The track's width; until it is measured a likely one (the page is hidden until settled). */
	let measured = $state(0);
	const width = $derived(measured || 960);
	const hours = $derived(hoursOf(axis));
	/** A mark every hour, or every other hour when an hour is too narrow for its label. */
	const step = $derived(
		width / (hours.length - 1) < (format.hourCycle === 'h12' ? 60 : 40) ? 2 : 1,
	);
	const nowAt = $derived(nowFraction(nowMinute, axis));
	const hourFormat = $derived(
		new Intl.DateTimeFormat(format.dateLocale, {
			hour: format.hourCycle === 'h12' ? 'numeric' : '2-digit',
			timeZone: 'UTC',
			hourCycle: format.hourCycle,
		}),
	);
	/** An axis mark: the hour alone ("07", "7 AM"), formatted as a UTC instant of that hour. */
	const hourLabel = (h: number) => hourFormat.format(Date.UTC(2026, 0, 1, h % 24));
	const placed = $derived(
		lanes.map((lane) => {
			// All-day stretches lie behind the lane's blocks: they never push a block to a row. With
			// `allDayRow` each has a row of its own on top and the timed blocks start below them.
			const allDay = lane.items.filter((c) => c.kind === 'allday');
			const shift = allDayRow ? allDay.length : 0;
			const timed = layoutLane(
				lane.items.filter((c) => c.kind !== 'allday').map((c) => c.span),
				axis,
				width,
				MIN_BLOCK_PX,
				maxRows,
			).map((b) => ({ ...b, row: b.row + shift }));
			const blocks = new Map(timed.map((b) => [b.id, b]));
			allDay.forEach((c, i) =>
				blocks.set(c.item.id, { id: c.item.id, left: 0, width, row: allDayRow ? i : 0 }),
			);
			return { lane, blocks, rows: Math.max(rowsOf(timed), shift) };
		}),
	);
	const isEnded = (c: LaneItem) =>
		nowMinute !== null && (c.item.end ?? c.item.start ?? 0) <= now && c.kind !== 'allday';
</script>

<div
	class="chart"
	style:--hours={hours.length - 1}
	role="group"
	aria-label={label}
	data-testid="day-chart"
>
	<div class="corner"></div>
	<div class="axis" aria-hidden="true" bind:clientWidth={measured}>
		{#each hours as h, i (h)}
			{#if i % step === 0}
				<span class:end={i === hours.length - 1} style:left="{(i / (hours.length - 1)) * 100}%"
					>{hourLabel(h)}</span
				>
			{/if}
		{/each}
	</div>

	{#if weather}
		<div class="hd wx">
			<span class="t"><b>{weather.label}</b><small>{weather.range}</small></span>
		</div>
		<div class="lane wx">
			<WeatherRow
				hours={weather.hours}
				{axis}
				day={weather.day}
				{nowMinute}
				{format}
				condition={weather.condition}
			/>
			{#if nowAt !== null}
				<span class="nowtag" style:left="{nowAt * 100}%" data-testid="now-tag"
					>{formatClock(now, format)}</span
				>
			{/if}
		</div>
	{/if}

	{#each placed as { lane, blocks, rows }, li (lane.key)}
		<div class="hd" class:first={li === 0 && !weather}>
			{#if lane.kind === 'others'}
				<span class="disc" aria-hidden="true">+{lane.people}</span>
			{:else}
				<Avatar name={lane.name} color={lane.color || 'var(--ink-soft)'} size={32} />
			{/if}
			<span class="t"
				><span class="nm"
					><b title={lane.name}>{lane.short ?? lane.name}</b>{#if lane.note}<span
							class="note"
							title={lane.note}>{lane.note}</span
						>{/if}</span
				><small>{lane.status}</small></span
			>
			{#if lane.chores}
				<span class="chores">
					<Ring
						done={lane.chores.done}
						total={lane.chores.total}
						color={lane.chores.color}
						size={34}
						stroke={4}
						dim={lane.chores.total === 0}
						name={lane.chores.name}
					/>
				</span>
			{/if}
		</div>
		<div
			class="lane"
			style:--rows={quiet && placed.length === 1 ? Math.max(rows, QUIET_ROWS) : rows}
			role="group"
			aria-label={lane.name}
			data-testid="lane"
			data-lane={lane.kind}
		>
			{#if quiet && li === 0}
				<div
					class="quiet"
					class:past-side={nowAt !== null && nowAt > 0.6}
					class:future-side={nowAt !== null && nowAt <= 0.6}
					style:--n={placed.length}
					style:--now={nowAt === null ? '' : `${nowAt * 100}%`}
					data-testid="quiet-day"
				>
					<div>
						<h2>{quiet.title}</h2>
						<p>{quiet.text}</p>
					</div>
				</div>
			{/if}
			{#each lane.items as c (c.item.id)}
				{@const b = blocks.get(c.item.id)}
				{#if b}
					<!-- A block opens its page; on a display (no link) it is a labelled picture. -->
					<svelte:element
						this={c.item.href ? 'a' : 'div'}
						href={c.item.href || undefined}
						role={c.item.href ? undefined : 'img'}
						class="blk {c.kind}"
						class:past={isEnded(c)}
						class:next={c.item.id === nextId}
						style:--m={c.color || 'var(--ink-soft)'}
						style:left="{b.left}px"
						style:width="{b.width}px"
						style:top="{8 + b.row * 40}px"
						aria-label={blockName(c)}
						data-testid="chart-block"
						data-start={c.kind === 'allday' ? undefined : fractionOf(c.span.start, axis).toFixed(4)}
						><span class="tt">{c.item.title}</span>{#if c.item.location && b.width >= 180}<small
								>· {c.item.location}</small
							>{/if}</svelte:element
					>
				{/if}
			{/each}
			{#if nowAt !== null}
				<span class="nowline" style:left="{nowAt * 100}%" aria-hidden="true"></span>
				{#if li === 0 && !weather}
					<span class="nowtag" style:left="{nowAt * 100}%" data-testid="now-tag"
						>{formatClock(now, format)}</span
					>
				{/if}
			{/if}
		</div>
	{/each}
</div>

<style>
	.chart {
		display: grid;
		grid-template-columns: var(--lanes-head, 10.625rem) minmax(0, 1fr);
		min-width: 0;
	}
	.axis {
		position: relative;
		height: 22px;
	}
	.axis span {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--ink-soft);
		white-space: nowrap;
	}
	/* The last mark ends at the chart's edge instead of running past it. */
	.axis .end {
		transform: translateX(-100%);
	}
	.hd {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		padding-inline-end: 12px;
		border-top: 1px solid var(--line);
	}
	.hd .t {
		display: grid;
		min-width: 0;
		line-height: 1.15;
	}
	.hd b {
		overflow: hidden;
		font-size: 13.5px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hd .nm {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}
	.hd .nm b {
		min-width: 0;
	}
	/* The name gives way before the note: "Home" stays whole. */
	.hd .note {
		flex: none;
		max-width: 60%;
		overflow: hidden;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hd small {
		overflow: hidden;
		font-size: 11.5px;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hd .chores {
		flex: none;
		margin-inline-start: auto;
	}
	.disc {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--idle);
		color: var(--ink);
		font-size: 12px;
		font-weight: 800;
	}
	.lane {
		position: relative;
		/* A row is 40 px: one row 52 px, two 92 px. */
		height: calc(12px + var(--rows, 1) * 40px);
		border-top: 1px solid var(--line);
		background-image: linear-gradient(to right, var(--line) 1px, transparent 1px);
		background-size: calc(100% / var(--hours)) 100%;
	}
	.hd.wx,
	.lane.wx {
		height: 58px;
	}
	.chart > .hd:nth-last-child(2),
	.chart > .lane:last-child {
		border-bottom: 1px solid var(--line);
	}
	.blk {
		position: absolute;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 36px;
		padding: 0 8px 0 7px;
		overflow: hidden;
		border-inline-start: 3px solid var(--m);
		border-radius: 8px;
		background: color-mix(in oklab, var(--m) 16%, var(--surface));
		color: var(--ink);
		font-size: 12.5px;
		font-weight: 700;
		text-decoration: none;
		white-space: nowrap;
	}
	.blk .tt {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.blk small {
		flex: none;
		font-weight: 500;
		color: var(--ink-soft);
	}
	.blk:hover .tt {
		text-decoration: underline;
	}
	.blk:focus-visible {
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
		border-inline-start-color: var(--ink-soft);
		background: var(--idle);
		font-weight: 600;
	}
	/* All day, or six hours and more: hollow, with a dashed edge, behind the lane's other blocks. */
	.allday,
	.long {
		z-index: 0;
		border-inline-start-style: dashed;
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--line);
	}
	/* The quiet day: the sentence across the empty lanes, on the side of the now-line with room. */
	.quiet {
		position: absolute;
		top: 0;
		right: 16px;
		left: 16px;
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Across every lane, and at least the first lane's own height (a lone lane is taller). */
		height: max(calc(var(--n) * 52px), 100%);
		pointer-events: none;
	}
	.quiet.future-side {
		left: calc(var(--now) + 28px);
	}
	.quiet.past-side {
		right: calc(100% - var(--now) + 28px);
		left: 16px;
	}
	.quiet > div {
		display: grid;
		gap: 4px;
		max-width: 34rem;
		padding: 10px 20px;
		border-radius: 12px;
		background: var(--wall);
		text-align: center;
	}
	.quiet h2 {
		font-family: var(--font-family-display, var(--style-font-display, var(--font-family)));
		font-size: var(--ramp-hero, 1.875rem);
		font-weight: 800;
		font-stretch: 92%;
		line-height: 1.05;
		letter-spacing: -0.015em;
		color: var(--ink);
	}
	.quiet p {
		font-size: 14px;
		line-height: 1.4;
		color: var(--ink-soft);
	}
	.nowline {
		position: absolute;
		top: -1px;
		bottom: 0;
		z-index: 2;
		width: 2px;
		margin-inline-start: -1px;
		background: var(--now);
		pointer-events: none;
	}
	.nowtag {
		position: absolute;
		bottom: -1px;
		z-index: 3;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--now);
		color: var(--on-color);
		font-size: 10px;
		font-weight: 800;
		white-space: nowrap;
		transform: translate(-50%, 50%);
		pointer-events: none;
	}
	.lane:not(.wx) .nowtag {
		top: 0;
		bottom: auto;
		transform: translate(-50%, -50%);
	}
</style>
