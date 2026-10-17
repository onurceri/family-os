<script lang="ts">
	import {
		Clock,
		DateLine,
		type HourlyPoint,
		isMine,
		type NextUpMode,
		PhotoTile,
		QuietLine,
		Segmented,
		TodayBlock,
		TodayBlockMenu,
		TodayRow,
		TodaySection,
	} from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import { groupOf, sortTimeline } from '@famos/ui/timeline';
	import { MediaQuery } from 'svelte/reactivity';
	import FirstSteps from '#lib/FirstSteps.svelte';
	import { t } from '#lib/i18n.svelte.js';
	import {
		axisFor,
		chartItems,
		type LaneItem,
		type LaneView,
		MAX_LANES,
		minutesInDay,
		phonePeople,
		planLanes,
	} from './chart.js';
	import ChoreBars from './lanes/ChoreBars.svelte';
	import DayChart from './lanes/DayChart.svelte';
	import DayChartVertical from './lanes/DayChartVertical.svelte';
	import DepartureBoard, { type ThenLine } from './lanes/DepartureBoard.svelte';
	import { byTightness, type CompositionProps, type FitDrop } from './display-fit.js';

	/**
	 * Lanes: the day as a chart. On top the
	 * clock, the date and the weather; then the next thing as a departure board (the countdown on
	 * the accent, the title and the pill, "Then"); then one time axis from 07:00 to 22:00 with the
	 * hourly weather on it and a lane per person (at most six, then "Others") and one for the
	 * family, the day's things as blocks where they happen and the now-line across them; below,
	 * a band with Needs you, chores as bars, shopping as a number, what is ahead and the board.
	 * On a phone the chart turns (`DayChartVertical`) and the board loses "Then". A day with no
	 * timed things keeps the chart's frame (the axis, the weather, a lane per person with its
	 * status, the now-line): on the wide chart the quiet sentence is written across the empty
	 * lanes; on a phone it stands in the board's place above the folded, empty columns.
	 *
	 * Purely presentational, like Broadsheet: everything comes from `TodayData`, plus the hourly
	 * forecast for the weather row (read here, from the `weather` facet, and waited for before the
	 * page shows, so it composes once). Cards are mounted once at every width: the band is CSS.
	 *
	 * In family mode (a display) there is no person: no sentence, no Needs you, no toggle and no
	 * links; `status` (the display's pills) takes the bell's place, and the photo of the day joins
	 * the band. With names off the chart has one lane for everyone (more rows, all-day on top).
	 *
	 * A display fits one screen (`fit`): the lanes give up rows first (overlapping blocks share
	 * one), then the atmosphere (the photo, the weather's hours), the extras (shopping, the
	 * kitchen, the next days). Its widgets run across the page under the chart, or (`shift`) down a
	 * column of their own beside it; who is home stands in each lane's head, which is never left
	 * out. A display folds the chores into the lane heads, beside each one's
	 * status, instead of a block of bars (with names off, the family's total in its one lane). On a tablet held upright
	 * (640 to 1023 px) a display keeps the chart across the page.
	 */
	let { data, status, fit, band }: CompositionProps = $props();

	const wide = new MediaQuery('(min-width: 1024px)', false);
	const upright = new MediaQuery('(min-width: 640px)', false);
	/** The chart across the page: wide screens, and a display from 640 px. */
	const across = $derived(wide.current || (data.familyMode && upright.current));
	const gone = (what: FitDrop) => fit?.drop.has(what) ?? false;
	/** On a display each lane's head carries its chores' ring (names off: the family's total). */
	const choresInLanes = $derived(data.familyMode);
	const app = $derived(data.app);
	const words = $derived(data.words);
	/** Where things are shared with the family (Quick add), if this viewer may. */
	const share = $derived(app.share());
	const zone = $derived(data.timeZone);

	/* ───────────── the hourly weather of the chart's weather row ───────────── */

	const WEATHER_CAP_MS = 1200;
	let forecast = $state<{ hours: readonly HourlyPoint[]; min: number; max: number } | null>(null);
	let weatherLoaded = $state(false);
	const weather = $derived(data.weatherSource);

	async function loadWeather(source: typeof weather) {
		try {
			forecast = source ? await source.load(app) : null;
		} catch {
			// Keep what is on screen.
		} finally {
			weatherLoaded = true;
		}
	}
	$effect(() => {
		const source = weather;
		void data.today;
		void loadWeather(source);
		const refresh = source?.refreshMs
			? setInterval(() => void loadWeather(source), source.refreshMs)
			: undefined;
		const offs = (source?.invalidateOn ?? []).map((prefix) =>
			app.onEvent(prefix, () => void loadWeather(source)),
		);
		return () => {
			clearInterval(refresh);
			for (const off of offs) off();
		};
	});
	$effect(() => {
		if (!data.ready) return;
		const timer = setTimeout(() => (weatherLoaded = true), WEATHER_CAP_MS);
		return () => clearTimeout(timer);
	});
	/** The page shows once Today has settled and the weather row knows what it shows. */
	const ready = $derived(data.settled && weatherLoaded);
	/** Shown once ready and, on a display, once it has been fitted to the screen. */
	const shown = $derived(ready && !fit?.hold);
	$effect(() => {
		if (ready) fit?.ready();
	});

	/* ───────────── the chart ───────────── */

	/** With names off (a display) one lane holds everyone's day, so it may grow to more rows. */
	const NAMELESS_ROWS = 3;
	/** Rows a lane may grow to on a display, tighter as the screen asks. */
	const laneRows = $derived(
		data.showNames ? byTightness(fit, [2, 2, 1, 1]) : byTightness(fit, [NAMELESS_ROWS, 2, 2, 1]),
	);

	/** The chart's day: today, or tomorrow in the evening. */
	const chartDay = $derived(data.evening ? data.tomorrow : data.today);
	const charted = $derived(chartItems(data.dayItems, chartDay, zone));
	const axis = $derived(axisFor(charted.filter((c) => c.kind !== 'allday').map((c) => c.span)));
	const nowMinute = $derived(data.evening ? null : minutesInDay(data.now, data.today, zone));

	const colorOf = (id: string) => data.members.find((m) => m.id === id)?.color ?? '';
	/** A person's one clause; in the evening the chart is tomorrow's, so it names their first thing. */
	const statusOf = (id: string) => {
		if (!data.evening) return data.statuses.find((s) => s.id === id)?.status ?? '';
		const first = charted.find(
			(c) => (c.kind === 'event' || c.kind === 'long') && (c.item.members ?? []).includes(id),
		);
		return first?.item.start !== undefined
			? words.status.at(first.item.title, data.clock(first.item.start))
			: words.status.nothing;
	};

	/** A lane's chores, on a display (folded into its head). */
	const choresOf = (id: string) => {
		const ring = choresInLanes ? data.rings.find((r) => r.id === id) : undefined;
		return ring
			? {
					done: ring.done,
					total: ring.total,
					color: ring.color,
					name: words.choreRing(ring.name, ring.done, ring.total),
				}
			: undefined;
	};

	function lanesFor(max: number, withEmptyFamily: boolean): LaneView[] {
		const plan = planLanes(data.members, charted, max, (c) => c.item.members ?? []);
		const lanes: LaneView[] = plan.people.map(({ member, items }) => ({
			key: member.id,
			kind: 'person',
			name: member.displayName,
			short: member.shortName,
			color: member.color,
			status: statusOf(member.id),
			...(data.notes[member.id] && { note: data.notes[member.id] }),
			people: 1,
			items: items.map((c) => ({ ...c, color: member.color })),
			chores: choresOf(member.id),
		}));
		if (plan.others) {
			const ids = new Set(plan.others.members.map((m) => m.id));
			lanes.push({
				key: 'others',
				kind: 'others',
				name: t('lanes_others'),
				color: '',
				status: words.names(plan.others.members.map((m) => m.displayName)),
				people: plan.others.members.length,
				items: plan.others.items.map((c) => ({
					...c,
					color: colorOf((c.item.members ?? []).find((id) => ids.has(id)) ?? ''),
				})),
			});
		}
		if (withEmptyFamily || plan.family.length > 0) {
			const left = data.choresLeftFor(null);
			lanes.push({
				key: 'family',
				kind: 'family',
				name: words.family,
				color: '',
				status: left > 0 ? words.status.choresLeft(left) : '',
				people: 1,
				items: plan.family.map((c) => ({ ...c, color: '' })),
				chores: choresOf('anyone'),
			});
		}
		return lanes;
	}
	/** The phone: the family's column only when it has something; at most six columns in all. */
	const familyColumn = $derived(charted.some((c) => (c.item.members ?? []).length === 0));
	const lanes = $derived(
		across
			? lanesFor(MAX_LANES, true)
			: lanesFor(phonePeople(data.members.length, familyColumn), false),
	);

	const blockName = (c: LaneItem) =>
		c.kind === 'allday' || c.item.start === undefined || c.item.nominal
			? c.kind === 'allday'
				? t('lanes_block_all_day', { title: c.item.title })
				: c.item.title
			: t('lanes_block', { title: c.item.title, time: data.clock(c.item.start) });

	/** The quiet day's sentence, as the board's place says it on a phone. */
	const quietWords = $derived({
		title: t('home_quiet_title'),
		text: data.quietText,
	});

	const degrees = $derived(
		new Intl.NumberFormat(data.format.formatLocale, { maximumFractionDigits: 0 }),
	);
	const deg = (value: number) => `${degrees.format(Math.round(value) || 0)}°`;
	const weatherRow = $derived(
		forecast && forecast.hours.length > 0
			? {
					label: t('lanes_weather'),
					range: t('lanes_range', { max: deg(forecast.max), min: deg(forecast.min) }),
					hours: forecast.hours,
					day: chartDay,
				}
			: null,
	);

	/* ───────────── the board ───────────── */

	const then = $derived.by((): ThenLine[] => {
		const hero = data.hero;
		if (!hero || hero.start === undefined) return [];
		const me = data.me?.id ?? null;
		return sortTimeline(data.todayItems)
			.filter(
				(i) =>
					groupOf(i) === 1 &&
					i.start !== undefined &&
					!i.nominal &&
					i.kind !== 'meal' &&
					i.kind !== 'chore' &&
					!i.done &&
					i.id !== hero.id &&
					i.start >= (hero.start as number) &&
					(data.mode === 'family' || !me || isMine(i, me)),
			)
			.slice(0, 3)
			.map((i) => ({
				id: i.id,
				time: data.clock(i.start as number),
				title: i.title,
				color: data.colorOf(i),
				href: i.href,
			}));
	});
	/** What is ahead has one label for its cards: its menu hides the card when it is the only one. */
	const aheadMenu = $derived(
		data.aheadCards.length === 1 && data.aheadCards[0]
			? data.menuForCard(data.aheadCards[0])
			: undefined,
	);
	const modes = $derived([
		{ value: 'family', label: words.nextUp.family },
		{ value: 'me', label: words.nextUp.me },
	]);
</script>

{#snippet nextDaysList()}
	<ol class="nextdays" data-testid="next-days">
		{#each data.nextDaysItems as item (item.id)}
			{@const timed = groupOf(item) === 1 && item.start !== undefined && !item.nominal}
			{@const color = data.colorOf(item)}
			<li>
				<svelte:element this={item.href ? 'a' : 'div'} href={item.href || undefined} class="row">
					<span class="d font-display">{data.dayLabel(item.day)}</span>
					<span class="w">
						<i style:background-color={color || 'var(--ink-soft)'} aria-hidden="true"></i>
						<b>{item.title}</b>
					</span>
					<small>{timed ? data.clock(item.start as number) : t('home_next_all_day')}</small>
				</svelte:element>
			</li>
		{/each}
	</ol>
{/snippet}

<div
	class="ln"
	class:fm={data.familyMode}
	class:shift={fit?.shift}
	class:pending={!shown}
	aria-busy={!shown}
	data-testid="today-body"
	data-settled={shown}
	data-layout="lanes"
>
	<!-- ───────────── the clock, the date and the weather ───────────── -->
	<div class="top">
		<header class="head" style:--o="1">
			<div class="clockrow">
				{#if data.shows('clock')}
					<Clock now={data.now} format={data.format} />
					<div class="when">
						<DateLine now={data.now} format={data.format} variant="plain" heading />
					</div>
				{/if}
				{#if status}
					<div class="status" data-testid="display-status">{@render status()}</div>
				{:else}
					<div class="bell empty:hidden md:hidden"><Slot name="today.head" /></div>
				{/if}
			</div>
			{#if !data.familyMode && data.shows('greeting')}
				<p class="sentence" aria-live="polite" data-testid="day-sentence">
					{#if data.settled}{#each data.sentence as run}{#if run.bold}<b>{run.text}</b
								>{:else}{run.text}{/if}{/each}{:else}&nbsp;{/if}
				</p>
			{/if}
		</header>

		<div class="blk weather empty:hidden" style:--o="2">
			{#each data.atmosphere as c (c.id)}
				<Slot
					name="today.atmosphere"
					contributions={[c]}
					props={{
						form: 'block',
						variant: 'plain',
						strip: across || gone('atmosphere') ? 'none' : 'tiles',
						familyMode: data.familyMode,
						report: data.atmosphereReporter(c.id),
					}}
				/>
			{/each}
		</div>
	</div>

	<!-- ───────────── the next thing ───────────── -->
	{#if data.showSteps}
		<div class="blk" style:--o="4">
			<FirstSteps steps={data.steps} onhide={() => data.hideSteps()} />
		</div>
	{/if}

	{#if !data.shows('next')}
		<!-- The next thing is hidden here: nothing takes its place. -->
	{:else if data.hero}
		<div class="blk" style:--o="5">
			<DepartureBoard
				item={data.hero}
				now={data.now}
				format={data.format}
				words={words.nextUp}
				member={data.heroMember}
				mode={data.mode}
				onmode={data.familyMode ? undefined : (mode: NextUpMode) => void data.setMode(mode)}
				{then}
				thenTitle={t('lanes_then')}
				thenNone={t('lanes_then_none')}
				compact={!across}
			/>
		</div>
	{:else if data.nothingForMe}
		<div class="blk none-for-me" style:--o="5" data-testid="next-up-none">
			<p>{words.noneForMe}</p>
			<Segmented
				options={modes}
				value={data.mode}
				label={words.nextUp.toggle}
				size="sm"
				onchange={(mode) => void data.setMode(mode as NextUpMode)}
			/>
		</div>
	{:else if data.showEvening}
		<section class="blk note" style:--o="5" data-testid="evening">
			<h2>{t('home_evening_title')}</h2>
			<p>{data.eveningText}</p>
		</section>
	{:else if data.quietDay && !across}
		<!-- On the wide chart the quiet sentence is written across the empty lanes. -->
		<section class="blk note" style:--o="5" data-testid="quiet-day">
			<h2>{quietWords.title}</h2>
			<p>{quietWords.text}</p>
		</section>
	{/if}

	<!-- ───────────── the day as a chart (a display needs what a timeline requires) ───────────── -->
	{#if data.showsDay && data.shows('day')}
		<div class="blk" style:--o="7">
			{#if across}
				{#if data.evening}
					<h2 class="label chart-title">
						{t('home_tomorrow_title', { weekday: data.tomorrowWeekday })}
					</h2>
				{/if}
				<DayChart
					{lanes}
					{axis}
					now={data.now}
					{nowMinute}
					nextId={data.hero?.id ?? null}
					format={data.format}
					label={t('lanes_chart')}
					{blockName}
					weather={gone('atmosphere') ? null : weatherRow}
					quiet={data.quietDay ? quietWords : null}
					maxRows={fit || !data.showNames ? laneRows : undefined}
					allDayRow={!data.showNames}
				/>
			{:else}
				<TodayBlock block={data.menuFor('day')}>
					<TodaySection
						title={data.evening
							? t('home_tomorrow_title', { weekday: data.tomorrowWeekday })
							: t('lanes_chart')}
						href={data.dayHref}
						more={t('home_day_link')}
					>
						<DayChartVertical
							{lanes}
							{axis}
							now={data.now}
							{nowMinute}
							nextId={data.hero?.id ?? null}
							format={data.format}
							label={t('lanes_chart')}
							{blockName}
						/>
					</TodaySection>
				</TodayBlock>
			{/if}
		</div>
	{/if}

	<!-- ───────────── the band ───────────── -->
	<div class="band">
		<section
			class="blk {data.needsTotal === 0 ? 'hidden' : ''}"
			style:--o="3"
			aria-labelledby="needs-title"
			data-testid="needs-you"
		>
			<div class="labelrow">
				<span class="dot" aria-hidden="true"></span>
				<h2 id="needs-title" class="label">
					{t('home_needs_title')}<span class="count">{data.needsTotal}</span>
				</h2>
				{#if share}
					<a href={share.path} class="more">{t('home_needs_link')}</a>
				{/if}
				<TodayBlock block={data.menuFor('needs')}><TodayBlockMenu /></TodayBlock>
			</div>
			<div class="needs">
				{#each data.needsCards as c (c.id)}
					<TodayBlock block={data.menuForCard(c)}
						><Slot
							name="dashboard.card"
							contributions={[c]}
							props={data.propsFor(c, 'wide')}
						/></TodayBlock
					>
				{/each}
				{#if data.showAiRow}
					<TodayRow
						variant="needs"
						title={t('home_ai_row_title')}
						meta={t('home_ai_missing_text')}
						href="/settings/ai"
					>
						{#snippet trailing()}
							<button type="button" class="ghost" onclick={() => data.dismissAi()}
								>{t('home_ai_row_dismiss')}</button
							>
							<a href="/settings/ai" class="soft">{t('home_ai_missing_action')}</a>
						{/snippet}
					</TodayRow>
				{/if}
			</div>
		</section>

		{#if data.rings.length > 0 && !choresInLanes}
			<div class="blk" style:--o="8">
				<TodayBlock block={data.menuFor(data.countsBlock)}>
					<TodaySection title={words.choresToday} href={data.countsHref} more={words.chores}>
						<ChoreBars
							rings={data.rings}
							label={words.chores}
							name={(r) => words.choreRing(r.name, r.done, r.total)}
						/>
					</TodaySection>
				</TodayBlock>
			</div>
		{/if}

		{#each data.glanceCards as c (c.id)}
			<div class="blk empty:hidden" class:gone={gone('extras')} data-drop="extras" style:--o="8">
				<TodayBlock block={data.menuForCard(c)}
					><Slot
						name="dashboard.card"
						contributions={[c]}
						props={data.propsFor(c, 'wide', 'glance')}
					/></TodayBlock
				>
			</div>
		{/each}

		<!-- The photo of the day: on a display (family mode), beside the numbers. -->
		{#if data.familyMode && data.photoOfTheDay}
			<div class="blk" class:gone={gone('photo')} data-drop="photo" style:--o="8">
				<PhotoTile src={data.photoOfTheDay.src} label={data.photoOfTheDay.label} height={150} />
			</div>
		{/if}

		{#each data.dayCards as c (c.id)}
			<div class="blk empty:hidden" style:--o="9">
				<TodayBlock block={data.menuForCard(c)}
					><Slot
						name="dashboard.card"
						contributions={[c]}
						props={data.propsFor(c, 'wide')}
					/></TodayBlock
				>
			</div>
		{/each}

		{#if data.showNext}
			<div class="blk" class:gone={gone('extras')} data-drop="extras" style:--o="9">
				<TodayBlock block={data.menuFor('nextDays')}>
					<TodaySection title={t('home_next_title')} href={data.dayHref} more={t('home_next_link')}>
						{@render nextDaysList()}
					</TodaySection>
				</TodayBlock>
			</div>
		{/if}

		<section
			class="blk {data.aheadTotal === 0 ? 'hidden' : ''}"
			class:gone={gone('extras')}
			data-drop="extras"
			style:--o="10"
			aria-labelledby="ahead-title"
		>
			<TodayBlock block={aheadMenu}>
				<div class="labelrow">
					<h2 id="ahead-title" class="label">{t('home_ahead_title')}</h2>
					<TodayBlockMenu />
				</div>
			</TodayBlock>
			<div class="ahead">
				{#each data.aheadCards as c (c.id)}
					<TodayBlock block={data.menuForCard(c)}
						><Slot
							name="dashboard.card"
							contributions={[c]}
							props={data.propsFor(c, 'wide')}
						/></TodayBlock
					>
				{/each}
			</div>
		</section>

		{#each data.rowCards as c (c.id)}
			<div class="blk two empty:hidden" style:--o="11">
				<TodayBlock block={data.menuForCard(c)}
					><Slot
						name="dashboard.card"
						contributions={[c]}
						props={data.propsFor(c, 'wide')}
					/></TodayBlock
				>
			</div>
		{/each}

		{#if data.showCapture}
			<div class="blk wide max-md:hidden" style:--o="13">
				<TodaySection title={t('home_capture_title')}>
					<Slot name="today.capture" />
				</TodaySection>
			</div>
		{/if}

		{#if data.doneLine}
			<div class="blk wide" style:--o="14">
				<QuietLine text={data.doneLine} testid="done-line" />
			</div>
		{/if}
		{#if data.quiet}
			<div class="blk wide" style:--o="15"><QuietLine text={data.quiet} /></div>
		{/if}
		{#if data.footCards.length > 0}
			<div class="blk wide foot" style:--o="16" data-testid="today-foot">
				{#each data.footCards as c (c.id)}
					<TodayBlock block={data.menuForCard(c)}
						><Slot
							name="dashboard.card"
							contributions={[c]}
							props={data.propsFor(c, 'wide')}
						/></TodayBlock
					>
				{/each}
			</div>
		{/if}
	</div>
	{#if band}
		<!-- A display's widgets: under the chart, across the page (gone when it has nothing). -->
		<div class="widgets" style:--o="19">{@render band()}</div>
	{/if}
</div>

<style>
	/* The phone first: one column, the blocks in the order of `--o`. */
	.ln {
		--ramp-clock: 3.75rem;
		--ramp-date: 1.125rem;
		--ramp-countdown: 3.5rem;
		--ramp-hero: 1.625rem;
		--ramp-big: 2.75rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 22px;
		max-width: 96rem;
	}
	.top,
	.band {
		display: contents;
	}
	.ln > *,
	.top > *,
	.band > * {
		order: var(--o, 50);
		min-width: 0;
	}
	/* Until the page has settled only the head shows; the rest is mounted, hidden. */
	.pending {
		visibility: hidden;
	}
	.pending .head {
		visibility: visible;
	}
	.blk {
		transition: opacity 150ms;
	}
	.pending .blk {
		opacity: 0;
	}
	@media (prefers-reduced-motion: reduce) {
		.blk {
			transition: none;
		}
	}

	/* ── the head: Archivo, condensed, for the clock and the date ── */
	.head {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.clockrow {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	/* A display's pills: beside the date when there is room, else under it. */
	.clockrow:has(.status) {
		flex-wrap: wrap;
	}
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.status:empty {
		display: none;
	}
	.top :global(.clock) {
		font-weight: 800;
		font-stretch: 68%;
		line-height: 0.9;
	}
	.when {
		flex: 1;
		min-width: 0;
	}
	.when :global(.dateline .date) {
		font-family: var(--font-family-display, var(--style-font-display, var(--font-family)));
		font-weight: 800;
		font-stretch: 80%;
		line-height: 1;
	}
	.when :global(.dateline .weekday) {
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	.sentence {
		max-width: 40ch;
		font-size: 14px;
		line-height: 1.4;
		color: var(--ink-soft);
	}
	.sentence b {
		font-weight: 700;
		color: var(--ink);
	}
	.weather :global([data-testid='weather-block'] .temp) {
		font-stretch: 68%;
		letter-spacing: -0.01em;
	}

	/* ── notes in the place of the board ── */
	.note {
		display: grid;
		gap: 6px;
		max-width: 40ch;
	}
	.note h2,
	.none-for-me p {
		font-family: var(--font-family-display, var(--style-font-display, var(--font-family)));
		font-size: var(--ramp-hero);
		font-weight: 800;
		font-stretch: 92%;
		line-height: 1.05;
		letter-spacing: -0.015em;
		color: var(--ink);
	}
	.note p {
		font-size: var(--ramp-sentence, 1rem);
		line-height: 1.35;
		color: var(--ink-soft);
	}
	.none-for-me {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	/* ── the band ── */
	.label {
		min-width: 0;
		overflow: hidden;
		font-size: var(--ramp-label, 11.5px);
		font-weight: 700;
		letter-spacing: var(--ramp-label-tracking, 0.16em);
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
		color: var(--ink-soft);
	}
	.chart-title {
		margin-bottom: 6px;
	}
	.labelrow {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-height: 24px;
		margin-bottom: 10px;
	}
	.dot {
		flex: none;
		align-self: center;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--attention);
	}
	.count {
		margin-inline-start: 8px;
		font-weight: 600;
		letter-spacing: 0;
	}
	.more {
		flex: none;
		margin-inline-start: auto;
		font-size: 12px;
		font-weight: 700;
		color: var(--ink-soft);
	}
	.more:hover {
		color: var(--ink);
	}
	.needs {
		overflow: hidden;
		border-inline-start: 3px solid var(--attention);
		border-radius: 14px;
		background: var(--surface);
		box-shadow: var(--shadow-lit);
	}
	.needs > :global(* + *) {
		border-top: 1px solid var(--line);
	}
	.needs .ghost,
	.needs .soft {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 12px;
		border-radius: 8px;
		font-size: 14px;
		font-weight: 700;
	}
	.needs .ghost {
		color: var(--ink-soft);
	}
	.needs .ghost:hover {
		background: var(--idle);
	}
	.needs .soft {
		padding: 0 16px;
		background: var(--idle);
		color: var(--ink);
	}
	.ahead {
		display: grid;
		gap: 8px;
	}
	.nextdays {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.nextdays li + li {
		border-top: 1px solid var(--line);
	}
	.nextdays .row {
		display: grid;
		grid-template-columns: 4.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		color: var(--ink);
		text-decoration: none;
	}
	.nextdays a.row:hover b {
		text-decoration: underline;
	}
	.nextdays .d {
		font-size: 14px;
		font-weight: 800;
		font-stretch: 75%;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}
	.nextdays .w {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.nextdays i {
		flex: none;
		width: 9px;
		height: 9px;
		border-radius: 50%;
	}
	.nextdays b {
		overflow: hidden;
		font-size: 14px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nextdays small {
		font-size: 13px;
		color: var(--ink-soft);
		white-space: nowrap;
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 20px;
	}

	/* A display leaves out what does not fit its screen. */
	.gone {
		display: none !important;
	}
	.widgets {
		display: contents;
	}

	/* A display held upright (640 to 1023 px): the head on one row, the chart across the page, the
	   band as a grid, as from 1024 px. */
	@media (min-width: 640px) and (max-width: 1023.98px) {
		.ln.fm {
			--ramp-clock: 4.5rem;
			--ramp-countdown: 4.5rem;
			--ramp-hero: 1.875rem;
			--ramp-big: 3rem;
			--ramp-date: 1.375rem;
			--lanes-head: 9.75rem;
			gap: 24px;
		}
		.fm > * {
			order: 0;
		}
		.fm .top {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: center;
			gap: 28px;
		}
		.fm .top > * {
			order: 0;
		}
		.fm .band {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
			align-items: start;
			gap: 24px;
		}
		.fm .band > .wide {
			grid-column: 1 / -1;
		}
	}

	/* From 1024 px: the head is one row, the board and the chart take the width, the band is a grid. */
	@media (min-width: 1024px) {
		.ln {
			--ramp-clock: 4.5rem;
			--ramp-countdown: 4.5rem;
			--ramp-hero: 1.875rem;
			--ramp-big: 3rem;
			--ramp-date: 1.375rem;
			--lanes-head: 9.75rem;
			gap: 24px;
		}
		.ln > * {
			order: 0;
		}
		.top {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: center;
			gap: 28px;
		}
		.top > * {
			order: 0;
		}
		.band {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
			align-items: start;
			gap: 24px;
		}
		.band > * {
			order: var(--o, 50);
		}
		.band > .wide {
			grid-column: 1 / -1;
		}
		.band > .two,
		.band > [data-testid='needs-you'] {
			grid-column: span 2;
		}
	}

	/* A display from 1024 px: the band's tiles (shopping, the photo) side by side in the empty end
	   of the head's row; everything else takes the whole width. */
	@media (min-width: 1024px) {
		.ln.fm {
			grid-template-columns: minmax(min-content, 1fr) auto;
			column-gap: 32px;
		}
		.fm > * {
			grid-column: 1 / -1;
		}
		.fm > .top {
			grid-column: 1;
			grid-row: 1;
		}
		/* The clock and the weather keep a readable width (the head's column is never narrower than
		   they are): a head row too full for them runs past the screen, so the display gives up
		   something else instead of squeezing them. */
		.fm > .top:has(> .weather:not(:empty)) {
			grid-template-columns: auto minmax(16rem, 1fr);
		}
		.fm > .top > .head,
		.fm > .band {
			min-width: min-content;
		}
		.fm > .band {
			grid-column: 2;
			grid-row: 1;
			grid-template-columns: none;
			grid-auto-columns: 13rem;
			grid-auto-flow: column;
			align-items: center;
		}
		.fm .band > * {
			grid-column: auto;
		}
		/* When there is no room under the chart (`shift`), the widgets take a column of their own
		   at the end, from the head down beside the chart. */
		.ln.fm.shift {
			grid-template-columns: minmax(min-content, 1fr) auto 18.75rem;
		}
		.fm.shift > :not(.top, .band) {
			grid-column: 1 / 3;
		}
		.fm.shift > .widgets > :global(.foot) {
			grid-column: 3;
			grid-row: 1 / span 3;
		}
	}

	/* What Today hides leaves no empty row: the head without the clock and the sentence is only
	   the phone's bell, and the top or the band with nothing to show is not there. */
	.bell {
		margin-inline-start: auto;
	}
	@media (min-width: 768px) {
		.head:not(:has(.when, .sentence, .status)) {
			display: none;
		}
	}
	@media (min-width: 1024px) {
		.top:not(:has(> .head :is(.when, .sentence, .status), > .blk:not(:empty))) {
			display: none;
		}
		.top:not(:has(> .head :is(.when, .sentence, .status))) {
			grid-template-columns: minmax(0, 1fr);
		}
		.band:not(:has(> :not(.hidden, .gone, :empty))) {
			display: none;
		}
	}

	/* From 1280 px: the sizes of the design (a 92 px clock, an 84 px countdown, a 36 px title). */
	@media (min-width: 1280px) {
		.ln {
			--ramp-clock: 5.75rem;
			--ramp-countdown: 5.25rem;
			--ramp-hero: 2.25rem;
			--ramp-big: 3.5rem;
			--ramp-date: 1.625rem;
			--lanes-head: 10.625rem;
		}
	}
</style>
