<script lang="ts">
	import HourlyStrip, { type HourlyPoint } from './HourlyStrip.svelte';
	import { skySoftVars } from './sky.js';
	import WeatherSky from './WeatherSky.svelte';
	import type { TodayFormat } from './today-v3.js';

	/**
	 * The weather on Today: the temperature as a big number in the display face
	 * (`--ramp-big`), a caps summary and range beside it, the sentence that links the weather to
	 * the day (serif in Broadsheet, `variant="serif"`), then the hourly strip. Texts arrive
	 * translated (the sentence from ambient's `sayWeather`); the numbers are formatted here.
	 * With `sky` (the forecast's WMO code and whether it is day) the block becomes a panel with
	 * the weather sky behind it (`WeatherSky`); its secondary text is then a little darker, so it
	 * keeps 4.5:1 on the sky in every theme.
	 */
	let {
		temperature,
		format,
		summary,
		range,
		sentence,
		hours = [],
		strip = 'tiles',
		stripLabel,
		condition,
		source,
		variant = 'serif',
		sky,
	}: {
		temperature: number;
		format: TodayFormat;
		/** "Partly cloudy". */
		summary?: string;
		/** "H 19° · L 11° · 40 % rain". */
		range?: string;
		sentence?: string | null;
		hours?: readonly HourlyPoint[];
		strip?: 'tiles' | 'bars' | 'none';
		/** Accessible name of the hourly strip. */
		stripLabel: string;
		condition?: (code: number) => string;
		/** The attribution line ("Weather: Open-Meteo"). */
		source?: string;
		variant?: 'serif' | 'plain';
		/** The sky behind the block: the current WMO weather code and whether it is day. */
		sky?: { code: number; isDay: boolean } | undefined;
	} = $props();

	const degrees = $derived(
		`${new Intl.NumberFormat(format.formatLocale, { maximumFractionDigits: 0 }).format(Math.round(temperature) || 0)}°`,
	);
</script>

<div
	class="weather {variant}"
	class:has-sky={Boolean(sky)}
	style={sky ? skySoftVars() : undefined}
	data-testid="weather-block"
>
	{#if sky}<WeatherSky code={sky.code} isDay={sky.isDay} />{/if}
	<div class="head">
		<span class="temp font-display">{degrees}</span>
		{#if summary || range}
			<span class="facts">
				{#if summary}<span class="caps">{summary}</span>{/if}
				{#if range}<span class="caps">{range}</span>{/if}
			</span>
		{/if}
	</div>
	{#if sentence}<p class="say" class:font-serif={variant === 'serif'}>{sentence}</p>{/if}
	{#if strip !== 'none' && hours.length > 0}
		<HourlyStrip {hours} {format} variant={strip} label={stripLabel} {condition} />
	{/if}
	{#if source}<span class="source">{source}</span>{/if}
</div>

<style>
	.weather {
		display: grid;
		gap: 8px;
		min-width: 0;
		color: var(--ink);
	}
	/* A panel with the sky behind it (the sky sits under the content, inside the rounded box). */
	.has-sky {
		position: relative;
		isolation: isolate;
		overflow: hidden;
		padding: 16px 18px 14px;
		border-radius: var(--r-card);
	}
	.has-sky > :global(:not([data-sky])) {
		--ink-soft: var(--sky-soft);
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.plain .head {
		align-items: flex-end;
	}
	.temp {
		font-size: var(--ramp-big, 4rem);
		font-weight: 600;
		line-height: 0.85;
		letter-spacing: -0.01em;
		font-variant-numeric: tabular-nums;
	}
	.plain .temp {
		font-weight: 800;
		letter-spacing: -0.05em;
	}
	.facts {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.caps {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}
	.plain .caps {
		font-size: 14px;
		font-weight: 600;
		letter-spacing: 0;
		text-transform: none;
	}
	.say {
		margin: 0;
		max-width: 32ch;
		font-size: var(--ramp-sentence, 1.25rem);
		line-height: 1.25;
	}
	.serif .say {
		font-style: italic;
		font-weight: 400;
	}
	.plain .say {
		font-size: 18px;
		font-weight: 500;
		line-height: 1.3;
	}
	.source {
		font-size: 10px;
		color: var(--ink-soft);
	}
</style>
