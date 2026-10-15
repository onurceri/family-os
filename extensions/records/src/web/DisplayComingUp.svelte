<script lang="ts">
	import { todayIn } from '@famos/time';
	import { DisplayRow, DisplaySection } from '@famos/ui/famos';
	import { CalendarClock } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import type { Obligation } from '../contract/index.js';
	import { loadUpcoming } from './data.js';
	import { useRecords } from './i18n.js';
	import { dueLabel, stillMatters } from './status.js';

	/** Family display widget: duties due soon or overdue. Read-only, hidden when empty. */
	const { app, t } = useRecords();
	const MAX = 2;
	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 60_000);
	onDestroy(() => clearInterval(clock));
	const today = $derived(todayIn(app.timeZone(), now));

	let loadedItems = $state<Obligation[]>([]);
	const items = $derived(loadedItems.filter((o) => stillMatters(o, today)));
	async function load() {
		try {
			loadedItems = await loadUpcoming(30);
		} catch {
			// Keep what is on screen; the next refresh tries again.
		}
	}
	$effect(() => {
		void load();
		return app.onEvent('records.', () => void load());
	});
</script>

{#if items.length > 0}
	<DisplaySection title={t('coming_up')} count={String(items.length)}>
		{#snippet icon()}<CalendarClock class="text-now" />{/snippet}
		{#each items.slice(0, MAX) as o (o.id)}
			<DisplayRow
				variant="lit"
				title={o.title}
				subtitle="{o.recordName} · {dueLabel(o, today, t, app.dateLocale())}"
			/>
		{/each}
		{#if items.length > MAX}<p class="text-ink-soft px-1 text-[13px]">+{items.length - MAX}</p>{/if}
	</DisplaySection>
{/if}
