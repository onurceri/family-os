<script lang="ts">
	import type { Occurrence } from '../contract/index.js';
	import { isPast, stripeBackground, stripeColors } from './board.js';
	import { timeLabel } from './format.js';
	import { useCalendar } from './i18n.js';
	import { BLOCK, blockFit, isLongBlock } from './layout.js';

	/**
	 * An occurrence on the wide boards. `block` sits on the hour grid (positioned by the parent's
	 * `place`): a 3 px edge in the member's colour, title, and a second line when there is room.
	 * `line` is one tight row of a month cell; an all-day item there is a bar.
	 */
	let {
		occurrence,
		now,
		today,
		variant = 'block',
		place,
		titleOnly = false,
		showDetails = false,
		next = false,
		onclick,
	}: {
		occurrence: Occurrence;
		now: number;
		today: string;
		variant?: 'block' | 'line';
		/** Block only: where it sits in the day column. `top` and `height` are in px. */
		place?: { top: number; height: number; column: number; columns: number; span?: number };
		/** Block only: narrow columns show the title and nothing else. */
		titleOnly?: boolean;
		/** Block only: the day view also names the place and the people on separate lines. */
		showDetails?: boolean;
		/** Block only: today's next event, outlined in `accent` (the page's one "next" mark). */
		next?: boolean;
		onclick: () => void;
	} = $props();
	const { app, t } = useCalendar();

	const colors = $derived(stripeColors(occurrence, app.members()));
	const past = $derived(isPast(occurrence, now, today));
	const happening = $derived(
		!occurrence.allDay &&
			occurrence.start !== null &&
			occurrence.end !== null &&
			occurrence.start <= now &&
			now < occurrence.end,
	);
	const clock = (at: number) => timeLabel(at, app.timeZone(), app.dateLocale(), app.hourCycle());
	const time = $derived(
		occurrence.allDay || occurrence.start === null ? t('all_day') : clock(occurrence.start),
	);
	const range = $derived(
		occurrence.start !== null && occurrence.end !== null && occurrence.end > occurrence.start
			? `${clock(occurrence.start)}–${clock(occurrence.end)}`
			: time,
	);
	const who = $derived(
		occurrence.source
			? occurrence.source.name
			: app
					.members()
					.filter((m) => occurrence.memberIds.includes(m.id))
					.map((m) => m.displayName)
					.join(', '),
	);
	/** The second line: who and where; the time when neither is known. */
	const sub = $derived([who, occurrence.location ?? ''].filter(Boolean).join(' · ') || range);
	const label = $derived(
		[next ? t('next_event') : '', occurrence.title, range, who, occurrence.location]
			.filter(Boolean)
			.join(', '),
	);
	// Hollow, dashed: a long low-emphasis stretch (someone at work) must not hide the day.
	const long = $derived(
		occurrence.start !== null &&
			occurrence.end !== null &&
			isLongBlock(occurrence.start, occurrence.end),
	);
	// The lines under the title: who and where in the week; in the day view who, where and when each
	// on its own line when all of them fit, otherwise the week's one line.
	const details = $derived(
		showDetails ? [who || time, occurrence.location ?? '', range].filter(Boolean) : [sub],
	);
	const fit = $derived.by(() => {
		if (!place) return blockFit(0, 0);
		if (titleOnly) return blockFit(place.height, 0);
		const all = blockFit(place.height, details.length);
		return all.metaLines === details.length ? all : blockFit(place.height, 1);
	});
	const meta = $derived(
		fit.metaLines === 0 ? [] : fit.metaLines === details.length ? details : [sub],
	);
	const edge = $derived(stripeBackground(colors));
</script>

{#if variant === 'block' && place}
	<button
		type="button"
		data-testid="event-chip"
		data-long={long || undefined}
		data-next={next || undefined}
		aria-label={label}
		title={meta.length < details.length ? label : undefined}
		{onclick}
		style:top="{place.top}px"
		style:height="{place.height}px"
		style:padding-block="{fit.tight ? BLOCK.tight : BLOCK.pad}px"
		style:left="calc(100% * {place.column} / {place.columns} + 1px)"
		style:width="calc(100% * {place.span ?? 1} / {place.columns} - 2px)"
		style:outline={next ? '2px solid var(--accent)' : undefined}
		style:outline-offset={next ? '-2px' : undefined}
		style:z-index={next ? 1 : undefined}
		class="focus-visible:ring-ring absolute grid content-start overflow-hidden rounded-lg ps-2.5 pe-1.5 text-start outline-none focus-visible:z-10 focus-visible:ring-2 {long
			? 'border-line text-ink-soft border border-dashed bg-transparent'
			: occurrence.source
				? 'bg-idle border-line border'
				: 'bg-surface border-line border'} {past ? 'opacity-55' : ''} {happening && !long
			? 'ring-now z-[1] ring-2'
			: ''}"
	>
		<span class="absolute inset-y-0 start-0 w-[3px]" style:background={edge} aria-hidden="true"
		></span>
		<b
			class="text-[13px] font-bold {fit.titleLines === 2 ? 'line-clamp-2' : 'truncate'} {long
				? ''
				: 'text-ink'}"
			style:line-height="{BLOCK.title}px">{occurrence.title}</b
		>
		{#each meta as line, i (i)}
			<small
				class="text-ink-soft truncate text-[11px] font-semibold tabular-nums"
				style:line-height="{BLOCK.meta}px">{line}</small
			>
		{/each}
	</button>
{:else if occurrence.allDay}
	<button
		type="button"
		data-testid="event-chip"
		data-variant="bar"
		{onclick}
		aria-label={label}
		class="bg-idle focus-visible:ring-ring relative flex h-5 w-full min-w-0 items-center overflow-hidden rounded ps-2 pe-1 text-start text-xs outline-none focus-visible:ring-2 {past
			? 'opacity-55'
			: ''}"
	>
		<span class="absolute inset-y-0 start-0 w-[3px]" style:background={edge} aria-hidden="true"
		></span>
		<span class="text-ink min-w-0 flex-1 truncate font-semibold">{occurrence.title}</span>
	</button>
{:else}
	<button
		type="button"
		data-testid="event-chip"
		{onclick}
		aria-label={label}
		class="hover:bg-idle focus-visible:ring-ring flex h-5 w-full min-w-0 items-center gap-1.5 rounded px-1 text-start text-xs outline-none focus-visible:ring-2 {past
			? 'opacity-55'
			: ''}"
	>
		<span class="size-2 shrink-0 rounded-full" style:background={edge} aria-hidden="true"></span>
		<span class="text-ink-soft hidden shrink-0 tabular-nums xl:inline">{time}</span>
		<span class="text-ink min-w-0 flex-1 truncate font-semibold">{occurrence.title}</span>
	</button>
{/if}
