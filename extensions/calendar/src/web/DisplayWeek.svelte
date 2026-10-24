<script lang="ts">
	import { todayIn } from '@famos/time';
	import type { SlotProps } from '@famos/ui/slots';
	import { useNow } from '@famos/ui/now';
	import type { Occurrence } from '../contract/index.js';
	import { loadRange } from './data.js';
	import { nextDays } from './display-days.js';
	import { useCalendar } from './i18n.js';
	import WeekBoard from './WeekBoard.svelte';

	/**
	 * Family display page: the next seven days on the hour grid, read-only. The board fits the box without
	 * scrolling (a crowded stretch says "+N more" in its column). Nothing on it can be pressed.
	 * It reads again each time it comes round, when the calendar changes, and every five minutes.
	 */
	let { shown }: SlotProps['display.page'] = $props();
	const { app, t } = useCalendar();

	const clock = useNow(30_000);
	const now = $derived(clock.current);
	const today = $derived(todayIn(app.timeZone(), now));
	const week = $derived(nextDays(today));
	const first = $derived(week[0] as string);
	const last = $derived(week[6] as string);

	let items = $state<Occurrence[]>([]);
	/** The range the items were read for, so the board never shows another range's. */
	let loaded = $state('');
	let failed = $state(false);
	async function load() {
		const range = `${first}:${last}`;
		try {
			items = await loadRange(first, last);
			loaded = range;
			failed = false;
		} catch {
			failed = true;
		}
	}

	$effect(() => {
		if (!shown) return;
		// A new day (midnight) is read as well.
		void [first, last];
		void load();
		const refresh = setInterval(() => void load(), 5 * 60_000);
		return () => clearInterval(refresh);
	});
	$effect(() => app.onEvent('calendar.', () => void load()));

	const ready = $derived(loaded === `${first}:${last}`);
</script>

<div class="size-full">
	{#if !ready && failed}
		<p class="bg-idle text-ink-soft rounded-lg px-5 py-4 text-xl">{t('page_unavailable')}</p>
	{:else if ready && items.length === 0}
		<p class="bg-idle text-ink-soft rounded-lg px-5 py-4 text-xl">{t('page_empty')}</p>
	{:else}
		<!-- Inert: the board's chips and counts are buttons in the app and are nothing here. -->
		<div class="size-full" inert>
			<WeekBoard
				days={week}
				items={ready ? items : []}
				{now}
				{today}
				{ready}
				fit
				onopen={() => {}}
			/>
		</div>
	{/if}
</div>
