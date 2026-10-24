<script lang="ts" module>
	import { weatherKind } from '@famos/time';

	/** The icon of a WMO weather code (Open-Meteo): the shapes the hourly strip draws. */
	export type WeatherShape = 'clear' | 'partly' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

	export function weatherShape(code: number): WeatherShape {
		const kind = weatherKind(code);
		return kind === 'drizzle' ? 'rain' : kind;
	}
</script>

<script lang="ts">
	/**
	 * A small weather icon in `sun`, or `info` when the hour is wet. At `night` a clear sky is a
	 * moon and a partly cloudy one a moon behind a cloud, and every dry night hour is drawn in
	 * `ink-soft` (a sun-coloured cloud reads as day). Decorative.
	 */
	let {
		code,
		wet = false,
		night = false,
		size = 18,
	}: { code: number; wet?: boolean; night?: boolean; size?: number } = $props();
	const shape = $derived(weatherShape(code));
	const moon = $derived(night && (shape === 'clear' || shape === 'partly'));
	const dry = $derived(shape !== 'rain' && shape !== 'snow' && shape !== 'storm');
</script>

<svg
	class="wx"
	class:wet={wet || shape === 'rain' || shape === 'snow' || shape === 'storm'}
	class:dark={night && dry && !wet}
	data-shape={moon ? `${shape}-night` : shape}
	width={size}
	height={size}
	viewBox="0 0 24 24"
	aria-hidden="true"
>
	{#if moon && shape === 'clear'}
		<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
	{:else if moon}
		<path d="M14.5 3.2a4.5 4.5 0 0 0 5.6 5.9 4.5 4.5 0 0 1-2.4 3.4" />
		<path d="M7 20h9a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6 1.5A3 3 0 0 0 7 20z" />
	{:else if shape === 'clear'}
		<circle cx="12" cy="12" r="4" />
		<path
			d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
		/>
	{:else if shape === 'partly'}
		<path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4" />
		<path d="M15.9 12.3A4 4 0 0 0 8.8 10" />
		<path d="M8 20h9a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6 1.5A3 3 0 0 0 8 20z" />
	{:else if shape === 'fog'}
		<path d="M4 9h16M3 13h18M5 17h14" />
	{:else if shape === 'rain'}
		<path d="M7 16a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8h.5a4 4 0 0 1 0 8" />
		<path d="M8 19v2M12 18v3M16 19v2" />
	{:else if shape === 'snow'}
		<path d="M7 16a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8h.5a4 4 0 0 1 0 8" />
		<path d="M8 20h.01M12 19h.01M16 20h.01M10 22h.01M14 22h.01" />
	{:else if shape === 'storm'}
		<path d="M7 16a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8h.5a4 4 0 0 1 0 8" />
		<path d="m13 14-3 4h4l-3 4" />
	{:else}
		<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10h.5a4 4 0 0 1 0 8z" />
	{/if}
</svg>

<style>
	.wx {
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
		color: var(--sun);
	}
	.dark {
		color: var(--ink-soft);
	}
	.wet {
		color: var(--info);
	}
</style>
