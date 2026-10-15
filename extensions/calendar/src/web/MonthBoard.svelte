<script lang="ts">
	import { formatDate } from '@famos/time';
	import type { Occurrence } from '../contract/index.js';
	import { sameMonth } from './board.js';
	import { onDay } from './data.js';
	import EventChip from './EventChip.svelte';
	import { useCalendar } from './i18n.js';
	import { monthRows } from './layout.js';

	/**
	 * The month fills the board: a header row and 5 or 6 weeks. Each cell shows as many events as
	 * its height allows and "+N more" for the rest. A day opens as the day view (its number, "+N
	 * more" or empty space); an event opens in the side panel.
	 */
	let {
		grid,
		focus,
		items,
		now,
		today,
		onopen,
		onday,
	}: {
		grid: readonly string[];
		/** A date inside the shown month. */
		focus: string;
		items: readonly Occurrence[];
		now: number;
		today: string;
		onopen: (occurrence: Occurrence) => void;
		onday: (date: string) => void;
	} = $props();
	const { app, t } = useCalendar();
	const tz = $derived(app.timeZone());

	// The sixth week is dropped when it lies entirely in the next month.
	const dates = $derived(
		grid.length > 35 && !grid.slice(35).some((d) => sameMonth(d, focus)) ? grid.slice(0, 35) : grid,
	);
	const weeks = $derived(dates.length / 7);
	let height = $state(0);
	const rows = $derived(monthRows(height / weeks));

	const eventsOn = (date: string) =>
		items
			.filter((o) => onDay(o, date, tz))
			// All-day bars first, then by time.
			.sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.start ?? 0) - (b.start ?? 0));
</script>

<div
	class="bg-surface border-line flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border"
	data-testid="month-board"
>
	<div
		class="border-line text-ink-soft grid shrink-0 grid-cols-7 border-b text-center text-[11px] font-bold tracking-[var(--ramp-label-tracking,0.06em)] uppercase"
	>
		{#each dates.slice(0, 7) as date (date)}
			<span class="py-2.5">{formatDate(date, app.dateLocale(), { weekday: 'short' })}</span>
		{/each}
	</div>
	<ol
		class="grid min-h-0 flex-1 grid-cols-7"
		style:grid-auto-rows="minmax(0, 1fr)"
		bind:clientHeight={height}
	>
		{#each dates as date (date)}
			{@const isToday = date === today}
			{@const inMonth = sameMonth(date, focus)}
			{@const events = eventsOn(date)}
			{@const over = events.length > rows}
			{@const shown = over ? events.slice(0, rows - 1) : events}
			<li
				data-testid="month-day"
				data-date={date}
				class="border-line grid min-h-0 min-w-0 content-start gap-0.5 overflow-hidden border-s border-b p-1 {inMonth
					? ''
					: 'bg-wall'} {isToday ? 'bg-now/5' : ''}"
			>
				<button
					type="button"
					class="focus-visible:ring-ring font-display grid size-7 place-items-center justify-self-start rounded-full text-[15px] font-bold tabular-nums outline-none focus-visible:ring-2 {isToday
						? 'bg-now text-on-color'
						: inMonth
							? 'hover:bg-idle'
							: 'text-ink-soft hover:bg-idle'}"
					aria-label={t('open_day', { date: formatDate(date, app.dateLocale()) })}
					onclick={() => onday(date)}>{Number(date.slice(8))}</button
				>
				{#each shown as occurrence (`${occurrence.eventId}:${occurrence.key}`)}
					<EventChip {occurrence} {now} {today} variant="line" onclick={() => onopen(occurrence)} />
				{/each}
				{#if over}
					<button
						type="button"
						class="text-ink-soft hover:text-ink h-5 justify-self-start px-1 text-xs font-bold"
						onclick={() => onday(date)}
						>{t('more_events', { count: events.length - shown.length })}</button
					>
				{/if}
			</li>
		{/each}
	</ol>
</div>
