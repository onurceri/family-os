<script lang="ts">
	import { dayBounds } from '@famos/time';
	import { type HourlyPoint, isWetHour, type TodayFormat, WeatherIcon } from '@famos/ui/famos';
	import { type Axis, minutesInDay } from '../chart.js';

	/**
	 * The hourly weather on Lanes' time axis: one cell per hour of the axis, the icon and the
	 * temperature, hours gone faded. Only the hours of the chart's day are drawn; an hour the
	 * forecast does not cover is left empty. Degrees from `Intl` in the family's format locale.
	 */
	let {
		hours,
		axis,
		day,
		nowMinute,
		format,
		condition,
	}: {
		hours: readonly HourlyPoint[];
		axis: Axis;
		/** The chart's day (YYYY-MM-DD). */
		day: string;
		/** Minutes into the day now, or null when the chart is not about today. */
		nowMinute: number | null;
		format: TodayFormat;
		/** Names an hour's weather for screen readers. */
		condition?: (code: number) => string;
	} = $props();

	const degrees = $derived(
		new Intl.NumberFormat(format.formatLocale, { maximumFractionDigits: 0 }),
	);
	const byHour = $derived.by(() => {
		const { start, end } = dayBounds(day, format.timeZone);
		const map = new Map<number, HourlyPoint>();
		for (const h of hours)
			if (h.at >= start && h.at < end)
				map.set(Math.floor(minutesInDay(h.at, day, format.timeZone) / 60), h);
		return map;
	});
	const cells = $derived(
		Array.from({ length: (axis.to - axis.from) / 60 }, (_, i) => axis.from / 60 + i),
	);
</script>

<ol class="hrs" style:--n={cells.length} data-testid="weather-row">
	{#each cells as hour (hour)}
		{@const point = byHour.get(hour)}
		<li class:past={nowMinute !== null && (hour + 1) * 60 <= nowMinute}>
			{#if point}
				<WeatherIcon code={point.code} wet={isWetHour(point)} size={16} />
				<span class="t">{degrees.format(Math.round(point.temperature) || 0)}°</span>
				{#if condition}<span class="sr-only">{condition(point.code)}</span>{/if}
			{/if}
		</li>
	{/each}
</ol>

<style>
	.hrs {
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		height: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 3px;
		font-size: 0.75rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
	}
	.past {
		opacity: 0.45;
	}
</style>
