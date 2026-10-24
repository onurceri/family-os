<script lang="ts">
	import { todayIn } from '@famos/time';
	import { DisplayRow, DisplaySection } from '@famos/ui/famos';
	import { useNow } from '@famos/ui/now';
	import { CalendarClock } from '@lucide/svelte';
	import type { Obligation } from '../contract/index.js';
	import { loadUpcoming } from './data.js';
	import { useRecords } from './i18n.js';
	import { dueLabel, stillMatters } from './status.js';

	/** Family display widget: duties due soon or overdue. Read-only, hidden when empty. */
	let { rows }: { rows?: number } = $props();
	const { app, t } = useRecords();
	const MAX = 2;
	/** Fewer when the display has less room. */
	const max = $derived(Math.max(1, Math.min(MAX, rows ?? MAX)));
	const clock = useNow();
	const now = $derived(clock.current);
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
		{#each items.slice(0, max) as o (o.id)}
			<DisplayRow
				variant="lit"
				title={o.title}
				subtitle="{o.recordName} · {dueLabel(o, today, t, app.dateLocale())}"
			/>
		{/each}
		{#if items.length > max}<p class="text-ink-soft px-1 text-[13px]">+{items.length - max}</p>{/if}
	</DisplaySection>
{/if}
