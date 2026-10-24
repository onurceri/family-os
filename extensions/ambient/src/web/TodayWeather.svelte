<script lang="ts">
	import { HOUR_MS } from '@famos/time';
	import { CloudSun } from '@lucide/svelte';
	import { WeatherBlock } from '@famos/ui/famos';
	import { useNow } from '@famos/ui/now';
	import type { Weather } from '../contract/index.js';
	import type { SentenceItem } from '../contract/sentence.js';
	import { loadWeather } from './data.js';
	import { useAmbient } from './i18n.js';
	import { loadTimedItems, sayWeather } from './sentence.js';
	import { describeWeather } from './weather.js';

	/**
	 * The weather of a style's Today (`today.atmosphere` in the `block` form): the
	 * temperature as a big number, what the sky does and the day's range, the sentence that links
	 * the weather to the day's timed items (read through the calendar's route) and the next hours.
	 * When the weather is off and the person can turn it on, a link to the setting. It tells the
	 * page once it knows whether it shows something, so Today composes once. On a family display
	 * (`familyMode`) nothing is a link: the source is named as text.
	 */
	let {
		variant = 'serif',
		strip = 'tiles',
		familyMode = false,
		report,
	}: {
		variant?: 'serif' | 'plain';
		strip?: 'tiles' | 'bars' | 'none';
		familyMode?: boolean;
		report?: (r: { shown: boolean }) => void;
	} = $props();

	const { app, t } = useAmbient();
	let weather = $state<Weather | null>(null);
	let items = $state<SentenceItem[]>([]);
	let loaded = $state(false);
	const clock = useNow();
	const now = $derived(clock.current);

	async function load() {
		try {
			const [w, timed] = await Promise.all([
				loadWeather(),
				loadTimedItems(app).catch(() => [] as SentenceItem[]),
			]);
			weather = w;
			items = timed;
		} catch {
			// Keep what is on screen; the next refresh tries again.
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void load();
		const refresh = setInterval(() => void load(), 10 * 60_000);
		const offs = [
			app.onEvent('ambient.', () => void load()),
			app.onEvent('calendar.', () => void load()),
		];
		return () => {
			clearInterval(refresh);
			for (const off of offs) off();
		};
	});

	const forecast = $derived(weather?.enabled ? weather.forecast : null);
	const showHint = $derived(
		!familyMode && weather !== null && !weather.enabled && app.can('ambient.manage'),
	);
	const format = $derived({
		formatLocale: app.formatLocale(),
		dateLocale: app.dateLocale(),
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	});
	const degrees = $derived(new Intl.NumberFormat(app.formatLocale(), { maximumFractionDigits: 0 }));
	const deg = (value: number) => `${degrees.format(Math.round(value) || 0)}°`;
	const range = $derived.by(() => {
		if (!forecast) return '';
		const rain = forecast.precipitationProbability;
		return rain
			? t('today_range_rain', {
					max: deg(forecast.max),
					min: deg(forecast.min),
					percent: degrees.format(rain),
				})
			: t('today_range', { max: deg(forecast.max), min: deg(forecast.min) });
	});
	// From the hour under way on.
	const hours = $derived(forecast ? forecast.hourly.filter((h) => h.at + HOUR_MS > now) : []);
	const sentence = $derived(forecast ? sayWeather(forecast, items, now, app, t) : null);

	$effect(() => {
		if (loaded) report?.({ shown: Boolean(forecast) || showHint });
	});
</script>

{#if forecast}
	<div class="grid gap-2" data-testid="atmosphere">
		<WeatherBlock
			temperature={forecast.temperature}
			{format}
			summary={t(describeWeather(forecast.weatherCode, forecast.isDay).label)}
			{range}
			{sentence}
			{hours}
			{strip}
			stripLabel={t('today_hourly')}
			condition={(code) => t(describeWeather(code).label)}
			{variant}
			sky={{ code: forecast.weatherCode, isDay: forecast.isDay }}
		/>
		<!-- Open-Meteo's licence (CC BY 4.0) asks for this attribution where the data is shown. -->
		{#if familyMode}
			<span class="text-ink-soft justify-self-start text-[10px]">{t('today_source')}</span>
		{:else}
			<a
				href="https://open-meteo.com/"
				rel="noreferrer"
				target="_blank"
				class="text-ink-soft hover:text-ink justify-self-start text-[10px]">{t('today_source')}</a
			>
		{/if}
	</div>
{:else if showHint}
	<a
		href="/settings/photos-weather"
		class="text-ink-soft hover:text-ink inline-flex items-center gap-1.5 text-sm font-semibold"
		data-testid="atmosphere"
	>
		<CloudSun class="text-sun size-4 shrink-0" aria-hidden="true" />
		{t('atmosphere_hint')}
	</a>
{/if}
