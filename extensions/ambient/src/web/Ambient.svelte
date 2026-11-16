<script lang="ts">
	import { addDays, todayIn } from '@famos/time';
	import { colorVars, inertBeneath, overlayOpen, skySoftVars, WeatherSky } from '@famos/ui/famos';
	import { onDestroy, untrack } from 'svelte';
	import { DEFAULT_TIMING, type PhotoList, type Weather } from '../contract/index.js';
	import { type AgendaItem, slideshowPlan } from './agenda.js';
	import { api } from './api.js';
	import { loadPhotos, loadWeather } from './data.js';
	import {
		ACTIVITY_EVENTS,
		COVER_EVENTS,
		countsAsUse,
		coverInput,
		hasCover,
		idleSince,
		shouldCover,
		USE_EVENTS,
	} from './idle.js';
	import { useAmbient } from './i18n.js';
	import { rowsShown, shouldSwapSide, slideshowLayout } from './layout.js';
	import Slideshow from './Slideshow.svelte';
	import { formatDegrees, formatWhole } from './degrees.js';
	import { describeWeather } from './weather.js';

	/**
	 * Ambient mode of a family display or a family device. After a while without interaction
	 * (touch, pointer, key, wheel) it covers the screen with a photo slideshow (photos the family
	 * uploaded) beside a panel with the clock, the weather and the rest of today. The text never sits
	 * on a photo. On a display without photos it is a calm clock and agenda; a family device
	 * (`photosOnly`) is covered only when there are photos to show. It waits while a dialog or a side
	 * panel is open, and while it covers the screen the app beneath is inert. The touch or key that takes it away goes to the cover, never to what is under it. It
	 * only runs where photos or weather may be seen. A screen that has pages shows the photos as a
	 * page of the turn instead (`idle` is false), so the cover never hides the pages it was given.
	 */
	const { app, t } = useAmbient();
	const {
		time,
		date,
		onactive,
		idle = true,
		photosOnly = false,
	}: {
		time: string;
		date: string;
		onactive?: (active: boolean) => void;
		idle?: boolean;
		photosOnly?: boolean;
	} = $props();

	const canPhotos = $derived(app.can('ambient.photos'));
	const canWeather = $derived(app.can('ambient.weather'));
	const enabled = $derived(photosOnly ? canPhotos : canPhotos || canWeather);

	let photos = $state<PhotoList | null>(null);
	let weather = $state<Weather | null>(null);
	const timing = $derived(photos?.timing ?? weather?.timing ?? DEFAULT_TIMING);

	/** Whether there is something to cover the screen with (on a family device: photos). */
	const showable = $derived(
		hasCover({
			photosOnly,
			canPhotos,
			canWeather,
			photoCount: photos ? photos.ids.length : null,
		}),
	);

	let active = $state(false);
	let lastActivity = Date.now();

	// The screen is told when the cover goes up and when it comes down (it holds its own rotation
	// of pages meanwhile and starts again from Today).
	let told = false;
	$effect(() => {
		const covering = showable && active;
		if (covering === told) return;
		told = covering;
		onactive?.(covering);
	});

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

	// Content and settings: loaded when the screen starts, refreshed regularly and on changes.
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

	// Pages were added to the screen: the cover goes down and stays down.
	$effect(() => {
		if (!idle) active = false;
	});

	// Activity: any interaction ends ambient mode; silence starts it. While the cover is up, the
	// whole tap (or key) that ends it is caught before anything else hears of it, so it never
	// presses, focuses or closes what is under the cover; the app underneath stays as it was.
	$effect(() => {
		if (!enabled) return;
		let ending: ReturnType<typeof setTimeout> | undefined;
		const end = () => {
			clearTimeout(ending);
			ending = undefined;
			lastActivity = Date.now();
			active = false;
		};
		const input = (event: Event) => {
			const covering = active && showable;
			if ((ACTIVITY_EVENTS as readonly string[]).includes(event.type)) {
				lastActivity = Date.now();
				if (!covering) active = false;
			}
			const what = coverInput(event.type, covering);
			if (what === 'pass') return;
			event.stopPropagation();
			if (event.cancelable && !event.type.startsWith('touch')) event.preventDefault();
			if (what === 'end') end();
			// A swipe ends without a click: the cover still goes, once the touch is over.
			else if (what === 'endSoon' && ending === undefined) ending = setTimeout(end, 400);
		};
		// The wheel and a moving mouse are use too, but only a touch, a click or a key ends the cover.
		let lastCounted = 0;
		const use = () => {
			const at = Date.now();
			if (!countsAsUse(lastCounted, at)) return;
			lastCounted = at;
			if (!active) lastActivity = at;
		};
		for (const name of USE_EVENTS)
			window.addEventListener(name, use, { capture: true, passive: true });
		const options = { capture: true, passive: false };
		for (const name of COVER_EVENTS)
			window.addEventListener(
				name,
				input,
				name.startsWith('touch') ? { capture: true, passive: true } : options,
			);
		const ticker = setInterval(() => {
			const at = Date.now();
			const blocked = overlayOpen();
			if (!active) lastActivity = idleSince(lastActivity, at, blocked);
			if (
				showable &&
				shouldCover({
					idle,
					covering: active,
					overlayOpen: blocked,
					lastActivity,
					now: at,
					idleMinutes: timing.idleMinutes,
				})
			)
				active = true;
		}, 1000);
		return () => {
			for (const name of COVER_EVENTS) window.removeEventListener(name, input, { capture: true });
			for (const name of USE_EVENTS) window.removeEventListener(name, use, { capture: true });
			clearInterval(ticker);
			clearTimeout(ending);
		};
	});

	/* ───────────── Today and tomorrow (from the calendar, when the screen may see it) ───────────── */

	let items = $state<AgendaItem[]>([]);
	let now = $state(Date.now());
	let loadedAt = 0;
	let loadedDay = '';
	/** While idle the agenda is read this often; while covering, every minute. */
	const IDLE_REFRESH_MS = 5 * 60_000;

	async function loadAgenda() {
		if (!app.can('calendar.view')) return;
		const day = todayIn(app.timeZone(), Date.now());
		try {
			const res = await api.GET('/api/v1/calendar/occurrences', {
				params: { query: { from: day, to: addDays(day, 1) } },
			});
			if (!res.data) return;
			items = res.data.map((o) => ({
				id: `${o.eventId}:${o.key}`,
				title: o.title,
				allDay: o.allDay,
				start: o.start,
				end: o.end,
				startDate: o.startDate,
				endDate: o.endDate,
			}));
			loadedAt = Date.now();
			loadedDay = day;
		} catch {
			// Keep the last agenda.
		}
	}

	// Kept loaded while idle, so the first frame of the cover is already right; it follows the
	// calendar's changes and the turn of the day.
	$effect(() => {
		if (!enabled) return;
		void loadAgenda();
		const refresh = setInterval(() => {
			now = Date.now();
			const turned = loadedDay !== todayIn(app.timeZone(), now);
			if (active || turned || now - loadedAt >= IDLE_REFRESH_MS) void loadAgenda();
		}, 60_000);
		const off = app.onEvent('calendar.', () => void loadAgenda());
		return () => {
			clearInterval(refresh);
			off();
		};
	});

	// The cover going up: the clock and the agenda are made current at once.
	$effect(() => {
		if (!active) return;
		now = Date.now();
		untrack(() => void loadAgenda());
	});

	const plan = $derived(
		slideshowPlan(items, now, {
			timeZone: app.timeZone(),
			dateLocale: app.dateLocale(),
			hourCycle: app.hourCycle(),
		}),
	);

	// Follows resizes and turning the device, so a phone held upright gets the portrait layout.
	let viewportWidth = $state(window.innerWidth);
	let viewportHeight = $state(window.innerHeight);
	const layout = $derived(
		slideshowLayout({ width: viewportWidth, height: viewportHeight }, plan.when),
	);
	const list = $derived(rowsShown(plan.events.length, layout.rows));
	const rows = $derived(plan.events.slice(0, list.shown));
	/** The time column is as wide as the longest time, so every title starts at the same place. */
	const timeColumn = $derived(`${Math.max(5, ...rows.map((row) => row.time.length)) + 1}ch`);

	/* ───────────── Slideshow ───────────── */

	let shown = $state<string | null>(null);
	let cover = $state<HTMLElement>();

	// The app beneath is out of reach of a screen reader and the keyboard while the cover is up.
	$effect(() => {
		if (!cover) return;
		return inertBeneath(cover);
	});

	// In landscape the panel changes sides every half hour, on a photo change, so it rides the
	// crossfade and a fixed clock never marks the screen.
	let swapped = $state(false);
	let lastSwap = Date.now();
	$effect(() => {
		if (shown === null) return;
		const at = Date.now();
		if (!shouldSwapSide(lastSwap, at)) return;
		lastSwap = at;
		swapped = !swapped;
	});

	onDestroy(() => {
		active = false;
	});

	const forecast = $derived(weather?.enabled ? weather.forecast : null);
	const sky = $derived(forecast ? describeWeather(forecast.weatherCode, forecast.isDay) : null);
	const hasPhoto = $derived(shown !== null);
	const skyShown = $derived(!hasPhoto && forecast !== null);
	/** The calm screen without a photo lists what is left today, a few rows of it. */
	const NO_PHOTO_ROWS = 3;
	const calm = $derived(plan.when === 'today' ? plan.events.slice(0, NO_PHOTO_ROWS) : []);

	const portrait = $derived(layout.orientation === 'portrait');
	const size = $derived(
		layout.band
			? { clock: 'text-5xl', date: 'text-lg', row: 'text-lg', pad: 'p-5', gap: 'gap-1' }
			: portrait
				? { clock: 'text-6xl', date: 'text-xl', row: 'text-xl', pad: 'p-5', gap: 'gap-2' }
				: layout.short
					? { clock: 'text-6xl', date: 'text-xl', row: 'text-xl', pad: 'p-6', gap: 'gap-2' }
					: {
							clock: 'text-7xl min-[1700px]:text-8xl',
							date: 'text-2xl',
							row: 'text-2xl min-[1700px]:text-3xl',
							pad: 'p-8',
							gap: 'gap-3',
						},
	);
</script>

{#snippet weatherLine()}
	{#if forecast && sky}
		<div class="grid justify-items-end gap-1" data-testid="ambient-weather">
			<div class="flex items-center gap-4">
				<sky.icon class="text-sun size-14" aria-hidden="true" />
				<span class="text-6xl font-extrabold tabular-nums"
					>{formatDegrees(forecast.temperature, app.formatLocale(), forecast.unit)}</span
				>
			</div>
			<p class="text-2xl font-bold">
				{t(sky.label)} · {t('weather_today_range', {
					min: formatWhole(forecast.min, app.formatLocale()),
					max: formatWhole(forecast.max, app.formatLocale()),
				})}
			</p>
			{#if forecast.precipitationProbability !== null && forecast.precipitationProbability >= 20}
				<p class="text-xl font-semibold">
					{t('weather_rain_chance', {
						percent: formatWhole(forecast.precipitationProbability, app.formatLocale()),
					})}
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

<!-- The panel's weather: one line, no gap when there is none. -->
{#snippet panelWeather()}
	{#if forecast && sky}
		<div class="text-ink-soft grid gap-0.5" data-testid="ambient-weather">
			<p class="flex flex-wrap items-center gap-x-2 {size.date}">
				<sky.icon class="text-sun size-[1.2em] shrink-0" aria-hidden="true" />
				<span class="text-ink font-semibold tabular-nums"
					>{formatDegrees(forecast.temperature, app.formatLocale(), forecast.unit)}</span
				>
				<span>{t(sky.label)}</span>
			</p>
			<p class="text-sm">
				{t('weather_today_range', {
					min: formatWhole(forecast.min, app.formatLocale()),
					max: formatWhole(forecast.max, app.formatLocale()),
				})}{#if forecast.precipitationProbability !== null && forecast.precipitationProbability >= 20}
					· {t('weather_rain_chance', {
						percent: formatWhole(forecast.precipitationProbability, app.formatLocale()),
					})}{/if}
			</p>
			<a
				href="https://open-meteo.com/"
				tabindex="-1"
				rel="noreferrer"
				class="pointer-events-none text-xs opacity-80">{t('weather_attribution')}</a
			>
		</div>
	{/if}
{/snippet}

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

{#if showable && active}
	<!-- Above everything the app may have open (a side panel, a toast). A dialog is never open
	     when this starts (see `shouldCover`), so nothing floats over the photos. -->
	<div
		bind:this={cover}
		class="bg-wall text-ink fixed inset-0 z-[60] flex overflow-hidden {hasPhoto
			? portrait
				? 'flex-col'
				: swapped
					? 'flex-row-reverse'
					: 'flex-row'
			: ''}"
		data-testid="ambient"
		role="region"
		aria-label={t('ambient_cover_label')}
		style={skyShown ? skySoftVars() : undefined}
	>
		{#if skyShown && forecast}
			<!-- The weather sky fills the screen behind the clock; text on it uses the sky's soft ink. -->
			<div class="absolute inset-0 isolate">
				<WeatherSky code={forecast.weatherCode} isDay={forecast.isDay} size="screen" />
			</div>
		{/if}
		<!-- The photo has a pane of its own and nothing is drawn on it. -->
		<div
			class={hasPhoto
				? layout.band && portrait
					? 'relative min-h-0 flex-1'
					: portrait
						? 'relative h-[55%] shrink-0'
						: 'relative min-w-0 flex-1'
				: 'hidden'}
			data-testid="ambient-photo"
		>
			<Slideshow
				ids={photos?.ids ?? []}
				seconds={timing.slideSeconds}
				running={active}
				bind:shown
			/>
		</div>

		{#if hasPhoto}
			<section
				class="bg-wall text-ink flex min-w-0 flex-col overflow-hidden {size.pad} {size.gap} {layout.band
					? portrait
						? 'shrink-0 flex-row flex-wrap items-center justify-between gap-x-6'
						: 'w-[max(12rem,22%)] shrink-0 justify-center'
					: portrait
						? 'min-h-0 flex-1'
						: 'w-[max(20rem,38%)] shrink-0 justify-center'}"
				data-testid="ambient-panel"
				data-layout={layout.band ? 'band' : layout.orientation}
			>
				<!-- The clock never breaks over two lines. -->
				<span
					class="type-figure leading-none font-semibold tracking-tight whitespace-nowrap {size.clock}"
					data-testid="ambient-clock">{time}</span
				>
				<div class="grid gap-1">
					<p class="type-dateline text-ink-soft capitalize {size.date}">{date}</p>
					{@render panelWeather()}
				</div>

				{#if !layout.band}
					<div class="border-line mt-2 grid gap-2 border-t pt-3" data-testid="ambient-agenda">
						<p class="text-ink-soft text-sm font-semibold tracking-widest uppercase">
							{plan.when === 'tomorrow' ? t('ambient_tomorrow') : t('ambient_today')}
						</p>
						{#if plan.allDay.length > 0}
							<p class="text-ink-soft truncate text-base" data-testid="ambient-all-day">
								{t('ambient_all_day', { titles: plan.allDay.join(', ') })}
							</p>
						{/if}
						<ul class="grid gap-1" style="--time-column: {timeColumn}">
							{#each rows as event (event.id)}
								{@const next = event.id === plan.nextId}
								<li
									class="-mx-3 flex items-baseline gap-3 rounded-lg px-3 py-1 {size.row} {next
										? 'bg-accent text-on-accent font-semibold'
										: 'text-ink'}"
									data-next={next ? '' : undefined}
								>
									<span
										class="w-[var(--time-column)] shrink-0 whitespace-nowrap tabular-nums {next
											? ''
											: 'text-ink-soft'}">{event.time}</span
									>
									<span class="min-w-0 truncate">{event.title}</span>
								</li>
							{/each}
						</ul>
						{#if list.more > 0}
							<p class="text-ink-soft text-base" data-testid="ambient-more">
								{t('ambient_more', { count: list.more })}
							</p>
						{/if}
					</div>
				{/if}
			</section>
		{:else}
			<div
				style={skyShown ? colorVars('ink-soft', 'var(--sky-soft)') : undefined}
				class="relative z-10 grid flex-1 content-center gap-6 p-6 sm:p-10 md:grid-cols-[1fr_auto] md:items-end"
			>
				<div class="grid min-w-0 gap-3">
					<span
						class="text-7xl leading-none font-extrabold tracking-tight whitespace-nowrap tabular-nums sm:text-9xl"
						data-testid="ambient-clock">{time}</span
					>
					<p class="text-2xl font-bold capitalize sm:text-3xl">{date}</p>
					{#if calm.length > 0}
						<div class="mt-2 grid gap-1">
							<p class="text-lg font-bold opacity-80">{t('ambient_today')}</p>
							<!-- Times in one column that never wraps, titles beside them shortened to fit. -->
							<ul
								class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1"
								data-testid="ambient-agenda"
							>
								{#each calm as event, i (event.id)}
									{@const row =
										i === 0 ? 'text-2xl font-semibold' : 'text-xl font-medium opacity-80'}
									<li class="contents">
										<span class="whitespace-nowrap tabular-nums {row}">{event.time}</span>
										<span class="min-w-0 truncate {row}">{event.title}</span>
									</li>
								{/each}
							</ul>
						</div>
					{:else if app.can('calendar.view')}
						<p class="text-ink-soft text-2xl">{t('ambient_nothing')}</p>
					{/if}
				</div>
				{@render weatherLine()}
			</div>
		{/if}
	</div>
{/if}
