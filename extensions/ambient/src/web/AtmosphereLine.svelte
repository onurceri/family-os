<script lang="ts">
	import type { SlotProps } from '@famos/ui/slots';
	import { CloudSun } from '@lucide/svelte';
	import type { Weather } from '../contract/index.js';
	import { loadWeather } from './data.js';
	import { useAmbient } from './i18n.js';
	import TodayWeather from './TodayWeather.svelte';
	import { formatDegrees } from './degrees.js';
	import { describeWeather } from './weather.js';

	/**
	 * The weather on Today (`today.atmosphere`). `line`: one quiet line with Open-Meteo's
	 * attribution; `block`: a style's weather block (`TodayWeather`). When the weather is off
	 * and the person can turn it on, a link to the setting.
	 */
	let { form = 'line', variant, strip, report }: SlotProps['today.atmosphere'] = $props();
	const { app, t } = useAmbient();
	let weather = $state<Weather | null>(null);
	let loaded = $state(false);

	async function load() {
		try {
			weather = await loadWeather();
		} catch {
			// Keep what is on screen; the next refresh tries again.
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		if (form === 'block') return;
		void load();
		const refresh = setInterval(() => void load(), 10 * 60_000);
		const off = app.onEvent('ambient.', () => void load());
		return () => {
			clearInterval(refresh);
			off();
		};
	});

	const forecast = $derived(weather?.enabled ? weather.forecast : null);
	const sky = $derived(forecast ? describeWeather(forecast.weatherCode, forecast.isDay) : null);
	const showHint = $derived(weather !== null && !weather.enabled && app.can('ambient.manage'));
	$effect(() => {
		if (form === 'line' && loaded) report?.({ shown: Boolean(forecast) || showHint });
	});
</script>

{#if form === 'block'}
	<TodayWeather {variant} {strip} {report} />
{:else if forecast && sky}
	<span class="inline-flex flex-wrap items-center gap-x-1.5" data-testid="atmosphere">
		<sky.icon
			class="size-4 shrink-0 {forecast.isDay ? 'text-sun' : 'text-info'}"
			aria-hidden="true"
		/>
		<span
			>{formatDegrees(forecast.temperature, app.formatLocale(), forecast.unit)} · {t(
				sky.label,
			)}</span
		>
		<!-- Open-Meteo's licence (CC BY 4.0) asks for this attribution where the data is shown. -->
		<a
			href="https://open-meteo.com/"
			rel="noreferrer"
			target="_blank"
			class="hover:text-ink font-normal underline">{t('atmosphere_source')}</a
		>
	</span>
{:else if showHint}
	<a
		href="/settings/photos-weather"
		class="hover:text-ink inline-flex items-center gap-1.5"
		data-testid="atmosphere"
	>
		<CloudSun class="text-sun size-4 shrink-0" aria-hidden="true" />
		{t('atmosphere_hint')}
	</a>
{/if}
