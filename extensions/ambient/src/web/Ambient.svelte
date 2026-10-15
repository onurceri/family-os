<script lang="ts">
	import { todayIn } from '@famos/time';
	import { skySoftInk, WeatherSky } from '@famos/ui/famos';
	import { onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import { DEFAULT_TIMING, type PhotoList, type Weather } from '../contract/index.js';
	import { type AgendaEvent, nextEvents } from './agenda.js';
	import { api } from './api.js';
	import { loadPhotos, loadWeather, photoUrl } from './data.js';
	import { useAmbient } from './i18n.js';
	import { describeWeather } from './weather.js';

	/**
	 * Ambient mode of a family display. After a while without interaction (touch,
	 * pointer, key) it covers the widgets with a photo slideshow (photos the family uploaded),
	 * the clock, the next event and the weather. Without photos it is a calm clock and agenda.
	 * Any interaction takes it away again. It only runs on a display that may see photos or weather.
	 */
	const { app, t } = useAmbient();
	const { time, date }: { time: string; date: string } = $props();

	const canPhotos = $derived(app.can('ambient.photos'));
	const canWeather = $derived(app.can('ambient.weather'));
	const enabled = $derived(canPhotos || canWeather);

	let photos = $state<PhotoList | null>(null);
	let weather = $state<Weather | null>(null);
	const timing = $derived(photos?.timing ?? weather?.timing ?? DEFAULT_TIMING);

	let active = $state(false);
	let lastActivity = Date.now();

	const reducedMotion = () =>
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const fadeMs = $derived(reducedMotion() ? 0 : 1500);

	async function loadContent() {
		try {
			if (canPhotos) photos = await loadPhotos();
		} catch {
			// Keep what we have; the next refresh tries again.
		}
		try {
			if (canWeather) weather = await loadWeather();
		} catch {
			// Same.
		}
	}

	// Content and settings: loaded when the display starts, refreshed regularly and on changes.
	$effect(() => {
		if (!enabled) return;
		void loadContent();
		const refresh = setInterval(() => void loadContent(), 8 * 60_000);
		const off = app.onEvent('ambient.', () => void loadContent());
		return () => {
			clearInterval(refresh);
			off();
		};
	});

	// Activity: any interaction ends ambient mode; silence starts it.
	$effect(() => {
		if (!enabled) return;
		const touch = () => {
			lastActivity = Date.now();
			active = false;
		};
		const events = ['pointerdown', 'keydown', 'touchstart'] as const;
		for (const name of events) window.addEventListener(name, touch, { passive: true });
		const ticker = setInterval(() => {
			if (!active && Date.now() - lastActivity >= timing.idleMinutes * 60_000) active = true;
		}, 1000);
		return () => {
			for (const name of events) window.removeEventListener(name, touch);
			clearInterval(ticker);
		};
	});

	/* ───────────── Next events (from the calendar, when the display may see it) ───────────── */

	let agenda = $state<AgendaEvent[]>([]);
	let now = $state(Date.now());

	async function loadAgenda() {
		if (!app.can('calendar.view')) return;
		const day = todayIn(app.timeZone(), Date.now());
		try {
			const res = await api.GET('/api/v1/calendar/occurrences', {
				params: { query: { from: day, to: day } },
			});
			if (!res.data) return;
			agenda = res.data
				.flatMap((o) =>
					!o.allDay && o.start !== null
						? [{ id: `${o.eventId}:${o.key}`, title: o.title, start: o.start }]
						: [],
				)
				.toSorted((a, b) => a.start - b.start);
		} catch {
			// Keep the last agenda.
		}
	}

	$effect(() => {
		if (!active) return;
		void loadAgenda();
		now = Date.now();
		const refresh = setInterval(() => {
			now = Date.now();
			void loadAgenda();
		}, 60_000);
		const off = app.onEvent('calendar.', () => void loadAgenda());
		return () => {
			clearInterval(refresh);
			off();
		};
	});

	const upcoming = $derived(
		nextEvents(agenda, now, {
			timeZone: app.timeZone(),
			dateLocale: app.dateLocale(),
			hourCycle: app.hourCycle(),
		}),
	);

	/* ───────────── Slideshow ───────────── */

	let shown = $state<string | null>(null);
	let position = 0;
	let failures = 0;

	function load(url: string): Promise<boolean> {
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => resolve(true);
			image.onerror = () => resolve(false);
			image.src = url;
		});
	}

	$effect(() => {
		const ids = photos?.ids ?? [];
		if (!active || ids.length === 0) {
			shown = null;
			return;
		}
		let cancelled = false;
		failures = 0;

		/** Shows the next photo that loads; the one after it is fetched in advance. */
		async function advance() {
			while (!cancelled && failures < ids.length) {
				const url = photoUrl(ids[position % ids.length] as string);
				position++;
				if (await load(url)) {
					if (cancelled) return;
					shown = url;
					failures = 0;
					// Preload the next one so the crossfade never waits for the network.
					void load(photoUrl(ids[position % ids.length] as string));
					return;
				}
				failures++;
			}
		}
		void advance();
		const slide = setInterval(() => void advance(), timing.slideSeconds * 1000);
		return () => {
			cancelled = true;
			clearInterval(slide);
		};
	});

	onDestroy(() => {
		active = false;
	});

	const forecast = $derived(weather?.enabled ? weather.forecast : null);
	const sky = $derived(forecast ? describeWeather(forecast.weatherCode, forecast.isDay) : null);
	const hasPhoto = $derived(shown !== null);
	const skyShown = $derived(!hasPhoto && forecast !== null);
</script>

{#snippet weatherLine(onPhoto: boolean)}
	{#if forecast && sky}
		<div class="grid justify-items-end gap-1" data-testid="ambient-weather">
			<div class="flex items-center gap-4">
				<sky.icon class="size-14 {onPhoto ? '' : 'text-sun'}" aria-hidden="true" />
				<span class="text-6xl font-extrabold tabular-nums"
					>{Math.round(forecast.temperature)}{forecast.unit === 'fahrenheit' ? '°F' : '°C'}</span
				>
			</div>
			<p class="text-2xl font-bold">
				{t(sky.label)} · {t('weather_today_range', {
					min: Math.round(forecast.min),
					max: Math.round(forecast.max),
				})}
			</p>
			{#if forecast.precipitationProbability !== null && forecast.precipitationProbability >= 20}
				<p class="text-xl font-semibold">
					{t('weather_rain_chance', { percent: Math.round(forecast.precipitationProbability) })}
				</p>
			{/if}
			<a
				href="https://open-meteo.com/"
				tabindex="-1"
				rel="noreferrer"
				class="pointer-events-none text-sm opacity-80">{t('weather_attribution')}</a
			>
		</div>
	{/if}
{/snippet}

{#if enabled && active}
	<div
		class="fixed inset-0 z-50 overflow-hidden {hasPhoto
			? 'day bg-backdrop text-on-color'
			: 'bg-wall text-ink'} grid"
		data-testid="ambient"
		role="presentation"
		style:--sky-soft={skyShown ? skySoftInk : undefined}
	>
		{#if skyShown && forecast}
			<!-- The weather sky fills the screen behind the clock; text on it uses the sky's soft ink. -->
			<div class="absolute inset-0 isolate">
				<WeatherSky code={forecast.weatherCode} isDay={forecast.isDay} size="screen" />
			</div>
		{/if}
		{#if hasPhoto}
			{#key shown}
				<img
					src={shown}
					alt=""
					class="absolute inset-0 size-full object-cover"
					transition:fade={{ duration: fadeMs }}
				/>
			{/key}
			<!-- The scrim keeps white text readable on any photo, in light and dark themes. -->
			<div class="from-scrim absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t to-transparent"></div>
		{/if}

		<div
			style:--ink-soft={skyShown ? 'var(--sky-soft)' : undefined}
			class="relative z-10 grid gap-6 p-10 md:grid-cols-[1fr_auto] md:items-end {hasPhoto
				? 'content-end drop-shadow-lg'
				: 'content-center'}"
		>
			<div class="grid gap-3">
				<span
					class="leading-none font-extrabold tracking-tight tabular-nums {hasPhoto
						? 'text-8xl'
						: 'text-9xl'}"
					data-testid="ambient-clock">{time}</span
				>
				<p class="text-3xl font-bold capitalize">{date}</p>
				{#if upcoming.length > 0}
					<ul class="mt-2 grid gap-1" data-testid="ambient-agenda">
						{#each hasPhoto ? upcoming.slice(0, 1) : upcoming as event, i (event.id)}
							<li class="flex items-baseline gap-3 text-2xl font-semibold">
								{#if i === 0}<span class="text-lg font-bold opacity-80"
										>{t('ambient_next_event')}</span
									>{/if}
								<span class="tabular-nums">{event.time}</span>
								<span class="truncate">{event.title}</span>
							</li>
						{/each}
					</ul>
				{:else if !hasPhoto && app.can('calendar.view')}
					<p class="text-ink-soft text-2xl">{t('ambient_nothing')}</p>
				{/if}
			</div>
			{@render weatherLine(hasPhoto)}
		</div>
	</div>
{/if}
