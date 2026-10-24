<script lang="ts" module>
	import { HOUR_MS, isWetCode } from '@famos/time';
	/** One hour of the forecast (ambient's `Forecast.hourly`). */
	export interface HourlyPoint {
		at: number;
		temperature: number;
		code: number;
		precipitationProbability?: number | null;
	}

	/** An hour with a rain, snow or storm code, or at least a 50 % chance of rain. */
	export const isWetHour = (h: HourlyPoint): boolean =>
		isWetCode(h.code) || (h.precipitationProbability ?? 0) >= 50;

	/** The sun's day at the place: up from `rise` until `set` (epoch ms). */
	export interface SunDay {
		rise: number;
		set: number;
	}

	/** Without sunrise and sunset, the hours from 06:00 until 20:00 local are day. */
	export const DAY_FROM_HOUR = 6;
	export const NIGHT_FROM_HOUR = 20;
	const HALF_HOUR_MS = HOUR_MS / 2;

	/**
	 * Whether an hour of the forecast is night, so the strip draws a moon, not a sun. Judged at
	 * the middle of the hour: against the sun's days when the forecast has them, otherwise by the
	 * hour in the family's time zone (day from `DAY_FROM_HOUR` until `NIGHT_FROM_HOUR`).
	 */
	export function isNightHour(at: number, timeZone: string, sun?: readonly SunDay[]): boolean {
		const mid = at + HALF_HOUR_MS;
		if (sun && sun.length > 0) return !sun.some((d) => mid >= d.rise && mid < d.set);
		const hour = Number(
			new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(at),
		);
		return hour < DAY_FROM_HOUR || hour >= NIGHT_FROM_HOUR;
	}
</script>

<script lang="ts">
	import type { TodayFormat } from './today-v3.js';
	import WeatherIcon from './WeatherIcon.svelte';

	/**
	 * The next hours of the forecast. `tiles`: hour, icon and temperature per column,
	 * the hour under way on `idle` (Broadsheet). `bars`: the temperature as bars, wet hours in
	 * `info`, the hour under way in `ink` (Wall). Night hours get a moon (`isNightHour`). Hours from `Intl` in
	 * the date locale and hour cycle, degrees in the format locale; `condition` names an hour's weather for screen readers.
	 */
	let {
		hours,
		format,
		variant = 'tiles',
		count = 7,
		label,
		condition,
	}: {
		hours: readonly HourlyPoint[];
		format: TodayFormat;
		variant?: 'tiles' | 'bars';
		/** How many hours to show. */
		count?: number;
		/** Accessible name of the list ("Next hours"). */
		label: string;
		condition?: (code: number) => string;
	} = $props();

	const shown = $derived(hours.slice(0, count));
	const hourOf = $derived(
		new Intl.DateTimeFormat(format.dateLocale, {
			hour: format.hourCycle === 'h12' ? 'numeric' : '2-digit',
			timeZone: format.timeZone,
			hourCycle: format.hourCycle,
		}),
	);
	const degrees = $derived(
		new Intl.NumberFormat(format.formatLocale, { maximumFractionDigits: 0 }),
	);
	const temp = (value: number) => `${degrees.format(Math.round(value) || 0)}°`;
	const low = $derived(Math.min(...shown.map((h) => h.temperature)) - 4);
	const high = $derived(Math.max(...shown.map((h) => h.temperature)));
	const barHeight = (value: number) => 20 + (high > low ? ((value - low) / (high - low)) * 44 : 22);
</script>

{#if shown.length > 0}
	<ol class="strip {variant}" aria-label={label} data-testid="hourly-strip">
		{#each shown as h, i (h.at)}
			{@const wet = isWetHour(h)}
			<li class:current={i === 0} class:wet>
				{#if variant === 'tiles'}
					<span class="hour">{hourOf.format(h.at)}</span>
					<WeatherIcon code={h.code} {wet} night={isNightHour(h.at, format.timeZone)} />
					<span class="temp">{temp(h.temperature)}</span>
				{:else}
					<span class="temp">{temp(h.temperature)}</span>
					<i class="bar" style:height="{barHeight(h.temperature)}px"></i>
					<span class="hour">{hourOf.format(h.at)}</span>
				{/if}
				{#if condition}<span class="sr-only">{condition(h.code)}</span>{/if}
			</li>
		{/each}
	</ol>
{/if}

<style>
	.strip {
		display: grid;
		grid-auto-columns: minmax(0, 1fr);
		grid-auto-flow: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.tiles {
		gap: 2px;
	}
	.tiles li {
		display: grid;
		justify-items: center;
		gap: 5px;
		padding: 8px 0 6px;
		border-radius: 10px;
	}
	.tiles li.current {
		background: var(--idle);
	}
	.hour {
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-soft);
		white-space: nowrap;
	}
	.tiles .temp {
		font-size: 15px;
		font-weight: 700;
		color: var(--ink);
	}
	.bars {
		gap: 6px;
		align-items: end;
		height: 96px;
	}
	.bars li {
		display: grid;
		justify-items: center;
		align-content: end;
		gap: 4px;
		height: 100%;
	}
	.bars .temp {
		font-size: 12px;
		font-weight: 700;
		color: var(--ink);
	}
	.bar {
		display: block;
		width: 100%;
		border-radius: 6px 6px 3px 3px;
		background: color-mix(in oklab, var(--ink) 22%, transparent);
	}
	.bars .wet .bar {
		background: color-mix(in oklab, var(--info) 65%, transparent);
	}
	.bars .current .bar {
		background: var(--ink);
	}
</style>
