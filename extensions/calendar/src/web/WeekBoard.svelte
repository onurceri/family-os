<script lang="ts">
	import { dayBounds, formatDate, zoned } from '@famos/time';
	import { Plus } from '@lucide/svelte';
	import { tick } from 'svelte';
	import type { Occurrence } from '../contract/index.js';
	import { onDay } from './data.js';
	import EventChip from './EventChip.svelte';
	import { isWaiting } from './waiting.js';
	import { useCalendar } from './i18n.js';
	import {
		blockHeight,
		clipToDay,
		firstVisibleHour,
		FIT_LEAD,
		fitHour,
		fitWindow,
		hourHeight,
		isLongBlock,
		layoutDay,
		maxColumnsFor,
		overflowOf,
		snapSlot,
	} from './layout.js';
	import { timeLabel } from './format.js';

	/**
	 * The hour grid of the week and day views: a day header
	 * row, a lane of all-day items, then 24 hours that fill the height of the board and scroll for
	 * the rest. One column is the day view, seven the week.
	 */
	let {
		days,
		items,
		now,
		today,
		ready,
		onopen,
		onadd,
		onday,
		fit = false,
	}: {
		days: readonly string[];
		items: readonly Occurrence[];
		now: number;
		today: string;
		/** The items belong to these days (not a previous range still on screen). */
		ready: boolean;
		onopen: (occurrence: Occurrence) => void;
		/** Add an event on `date`, at `time` (HH:MM) when a slot was clicked. Omitted: the viewer cannot add. */
		onadd?: (date: string, time?: string) => void;
		/** Open one day (week view only). */
		onday?: (date: string) => void;
		/**
		 * The hours worth showing (the events', at least 07:00 to 22:00) fill the board's height and
		 * the board never scrolls, so a family display sees the whole day at once. A crowded stretch
		 * still shows "+N more" in its column.
		 */
		fit?: boolean;
	} = $props();
	const { app, t } = useCalendar();
	const tz = $derived(app.timeZone());

	const single = $derived(days.length === 1);
	let scroller = $state<HTMLElement>();
	let scrollH = $state(0);
	let headH = $state(0);
	let bodyW = $state(0);
	const bodyH = $derived(Math.max(0, scrollH - headH));
	// 94 px columns (1024 px windows) show the title only and a narrower gutter.
	const gutter = $derived(!single && bodyW < 900 ? 44 : 56);
	const colW = $derived((bodyW - gutter) / days.length);
	const titleOnly = $derived(!single && colW < 112);

	type Chip = { occurrence: Occurrence; start: number; end: number };
	const MAX_LANE = 3;

	const byDay = $derived(
		days.map((date) => {
			const { start: dayStart, end: dayEnd } = dayBounds(date, tz);
			const minutesOf = (at: number) => {
				const z = zoned(at, tz);
				return z.hour * 60 + z.minute;
			};
			const lane: Occurrence[] = [];
			const chips: Chip[] = [];
			for (const o of items.filter((o) => onDay(o, date, tz))) {
				if (o.allDay || o.start === null || o.end === null) {
					lane.push(o);
					continue;
				}
				const clip = clipToDay(o.start, o.end, dayStart, dayEnd, minutesOf);
				if (clip) chips.push({ occurrence: o, ...clip });
			}
			const key = (c: Chip) => `${c.occurrence.eventId}:${c.occurrence.key}`;
			// Long hollow blocks sit behind the day's other events and take no column of their own.
			const isLong = (c: Chip) =>
				isLongBlock(c.occurrence.start as number, c.occurrence.end as number);
			const normal = chips.filter((c) => !isLong(c));
			const spans = normal.map((c) => ({ id: key(c), start: c.start, end: c.end }));
			const placed = layoutDay(spans, undefined, maxColumnsFor(colW));
			const slots = new Map(normal.map((c, i) => [key(c), placed[i]]));
			const more = overflowOf(spans, placed).map((o) => ({
				...o,
				first: normal[placed.findIndex((p) => p.hidden && p.cluster === o.cluster)]
					?.occurrence as Occurrence,
			}));
			return {
				date,
				lane,
				more,
				chips: [...chips.filter(isLong), ...normal]
					.filter((chip) => !slots.get(key(chip))?.hidden)
					.map((chip) => ({
						chip,
						id: key(chip),
						place: slots.get(key(chip)) ?? {
							id: key(chip),
							column: 0,
							columns: 1,
							span: 1,
							cluster: -1,
							hidden: false,
						},
					})),
			};
		}),
	);
	const win = $derived(
		fit
			? fitWindow(
					byDay.flatMap((d) =>
						d.chips
							.filter(
								({ chip }) =>
									!isLongBlock(chip.occurrence.start as number, chip.occurrence.end as number),
							)
							.map(({ chip }) => chip),
					),
				)
			: null,
	);
	const hour = $derived(win ? fitHour(bodyH, win) : hourHeight(bodyH));
	// The next thing: today's first event still to start, marked in `accent`.
	const nextId = $derived.by(() => {
		if (!days.includes(today)) return null;
		let best: { id: string; start: number } | null = null;
		for (const d of byDay)
			if (d.date === today)
				for (const { chip, id } of d.chips) {
					const start = chip.occurrence.start;
					if (start === null || start <= now || chip.occurrence.allDay) continue;
					if (isLongBlock(start, chip.occurrence.end as number)) continue;
					// Something nobody approved yet is not what comes next.
					if (isWaiting(chip.occurrence)) continue;
					if (!best || start < best.start) best = { id, start };
				}
		return best?.id ?? null;
	});
	const laneRows = $derived(Math.min(MAX_LANE, Math.max(0, ...byDay.map((d) => d.lane.length))));

	const nowMinutes = $derived.by(() => {
		const z = zoned(now, tz);
		return z.hour * 60 + z.minute;
	});
	const hours = Array.from({ length: 23 }, (_, i) => i + 1);
	function hourLabel(h: number): string {
		const cycle = app.hourCycle();
		return new Intl.DateTimeFormat(app.dateLocale(), {
			hour: cycle === 'h12' ? 'numeric' : '2-digit',
			...(cycle === 'h12' ? {} : { minute: '2-digit' }),
			hourCycle: cycle,
			timeZone: 'UTC',
		}).format(Date.UTC(2026, 0, 5, h));
	}

	// On open: scroll to 07:00 or an hour before the first event, and keep the now-line in view.
	let scrolledFor = '';
	$effect(() => {
		const key = days.join(',');
		if (fit || !ready || !scroller || bodyH === 0 || scrolledFor === key) return;
		scrolledFor = key;
		const starts = byDay.flatMap((d) => d.chips.map((c) => c.chip.start));
		const el = scroller;
		void tick().then(() => {
			let top = Math.max(
				0,
				firstVisibleHour(starts.length ? Math.min(...starts) : null) * hour - 10,
			);
			if (days.includes(today)) {
				const y = (nowMinutes / 60) * hour;
				if (y < top + 12 || y > top + bodyH - 28) top = Math.max(0, y - bodyH * 0.6);
			}
			el.scrollTop = top;
		});
	});

	// Fitted: the window's first hour sits at the top, and nothing is left to scroll to.
	$effect(() => {
		if (!win || !scroller || bodyH === 0) return;
		const el = scroller;
		const top = Math.max(0, win.from * hour - FIT_LEAD);
		void tick().then(() => (el.scrollTop = top));
	});

	function slot(event: MouseEvent, date: string) {
		if (!onadd || event.target !== event.currentTarget) return;
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const minutes = snapSlot(((event.clientY - rect.top) / hour) * 60);
		onadd(
			date,
			`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
		);
	}
	const cols = $derived(`${gutter}px repeat(${days.length}, minmax(0, 1fr))`);
	const nowTag = $derived(timeLabel(now, tz, app.dateLocale(), app.hourCycle()));
	const nowIn = $derived(days.includes(today));
</script>

{#snippet dayHead(date: string, isToday: boolean)}
	<small
		class="text-[11px] font-bold tracking-[var(--ramp-label-tracking,0.06em)] uppercase {isToday
			? 'text-now'
			: 'text-ink-soft'}"
		>{formatDate(date, app.dateLocale(), { weekday: single ? 'long' : 'short' })}</small
	>
	<b
		class="type-day grid size-8 shrink-0 place-items-center rounded-full {isToday
			? 'bg-now text-on-color'
			: ''}"
		aria-current={isToday ? 'date' : undefined}>{Number(date.slice(8))}</b
	>
{/snippet}

<div
	class="bg-surface border-line flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border"
	data-testid="week-board"
	data-view={single ? 'day' : 'week'}
	data-title-only={titleOnly || undefined}
>
	<div
		bind:this={scroller}
		bind:clientHeight={scrollH}
		class="relative min-h-0 flex-1 {fit ? 'overflow-hidden' : 'overflow-y-auto'}"
	>
		<div bind:clientHeight={headH} class="bg-surface sticky top-0 z-20">
			<div class="border-line grid h-[52px] border-b" style:grid-template-columns={cols}>
				<span></span>
				{#each days as date (date)}
					{@const isToday = date === today}
					<div
						class="group border-line flex min-w-0 items-center gap-2 border-s px-2 {single
							? 'px-4'
							: ''}"
					>
						{#if onday && !single}
							<button
								type="button"
								onclick={() => onday(date)}
								aria-label={t('open_day', { date: formatDate(date, app.dateLocale()) })}
								class="focus-visible:ring-ring flex min-w-0 items-center gap-2 rounded-lg outline-none focus-visible:ring-2"
							>
								{@render dayHead(date, isToday)}
							</button>
						{:else}
							<div class="flex min-w-0 items-center gap-2">{@render dayHead(date, isToday)}</div>
						{/if}
						{#if onadd}
							<button
								type="button"
								class="text-ink-soft hover:bg-idle focus-visible:ring-ring ms-auto grid size-7 shrink-0 place-items-center rounded-lg opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
								aria-label={t('add_on', { date: formatDate(date, app.dateLocale()) })}
								onclick={() => onadd(date)}><Plus class="size-4" aria-hidden="true" /></button
							>
						{/if}
					</div>
				{/each}
			</div>
			<div
				class="bg-wall border-line grid border-b"
				style:grid-template-columns={cols}
				data-testid="all-day-lane"
			>
				<span
					class="text-ink-soft self-center px-1 text-center text-[10px] leading-tight font-bold tracking-wide uppercase"
					>{t('all_day')}</span
				>
				{#each byDay as d (d.date)}
					{@const over = d.lane.length > MAX_LANE}
					{@const shown = over ? d.lane.slice(0, MAX_LANE - 1) : d.lane}
					<div
						class="border-line grid min-w-0 content-start gap-0.5 border-s p-1 {d.date === today
							? 'bg-now/7'
							: ''}"
						style:min-height="{Math.max(1, laneRows) * 24 + 8}px"
					>
						{#each shown as occurrence (`${occurrence.eventId}:${occurrence.key}`)}
							<EventChip
								{occurrence}
								{now}
								{today}
								variant="line"
								onclick={() => onopen(occurrence)}
							/>
						{/each}
						{#if over}
							<button
								type="button"
								class="text-ink-soft hover:text-ink justify-self-start px-1 text-xs font-bold"
								onclick={() => (onday ? onday(d.date) : undefined)}
								>{t('more_events', { count: d.lane.length - shown.length })}</button
							>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<div
			bind:clientWidth={bodyW}
			class="relative grid"
			style:grid-template-columns={cols}
			style:height="{24 * hour}px"
			style:--hour="{hour}px"
		>
			<div class="relative" aria-hidden="true">
				{#each hours as h (h)}
					<span
						class="text-ink-soft font-display absolute end-1.5 -translate-y-1/2 text-xs font-semibold whitespace-nowrap tabular-nums"
						style:top="{h * hour}px">{hourLabel(h)}</span
					>
				{/each}
			</div>
			{#each byDay as d (d.date)}
				<!-- Empty space adds an event at that time; the "+" in the day's head is the keyboard route. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div
					data-testid="day-column"
					data-date={d.date}
					class="border-line relative min-w-0 border-s {onadd ? 'cursor-pointer' : ''} {d.date ===
					today
						? 'bg-now/5'
						: ''}"
					style:background-image="linear-gradient(to bottom, var(--line) 1px, transparent 1px)"
					style:background-size="100% var(--hour)"
					onclick={(e) => slot(e, d.date)}
				>
					{#each d.chips as { chip, id, place } (id)}
						<EventChip
							occurrence={chip.occurrence}
							{now}
							{today}
							place={{
								top: (chip.start / 60) * hour,
								height: blockHeight(chip.end - chip.start, hour),
								column: place.column,
								columns: place.columns,
								span: place.span,
							}}
							{titleOnly}
							next={id === nextId}
							showDetails={single}
							onclick={() => onopen(chip.occurrence)}
						/>
					{/each}
					{#each d.more as o (o.cluster)}
						<button
							type="button"
							data-testid="more-events"
							class="border-line bg-idle text-ink-soft focus-visible:ring-ring absolute grid place-items-start overflow-hidden rounded-lg border ps-2 text-start text-[12px] font-bold outline-none focus-visible:ring-2"
							style:top="{(o.start / 60) * hour}px"
							style:height="{blockHeight(o.end - o.start, hour)}px"
							style:left="calc(100% * {o.column} / {o.columns} + 1px)"
							style:width="calc(100% / {o.columns} - 2px)"
							onclick={(e) => {
								e.stopPropagation();
								if (onday) onday(d.date);
								else onopen(o.first);
							}}
						>
							{t('more_events', { count: o.count })}
						</button>
					{/each}
					{#if d.date === today && nowIn}
						<div
							class="pointer-events-none absolute inset-x-0 z-10"
							style:top="{(nowMinutes / 60) * hour}px"
							data-testid="now-line"
						>
							<span class="bg-now absolute inset-x-0 h-0.5 -translate-y-1/2"></span>
							<span
								class="bg-now absolute start-0 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
							></span>
							<span
								class="bg-now text-on-color absolute end-0 -translate-y-1/2 rounded-md px-1.5 py-px text-[11px] font-extrabold tabular-nums"
								>{nowTag}</span
							>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>
