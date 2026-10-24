<script lang="ts">
	import { todayIn } from '@famos/time';
	import { TodayRow } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import { useNow } from '@famos/ui/now';
	import { CalendarClock } from '@lucide/svelte';
	import type { Obligation } from '../contract/index.js';
	import { loadUpcoming } from './data.js';
	import { useRecords } from './i18n.js';
	import { dueLabel, dueStatus } from './status.js';

	/** Today, ahead band: obligations due in the next 30 days that are not late yet, across all records. */
	let { report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useRecords();
	const clock = useNow();
	const now = $derived(clock.current);
	const today = $derived(todayIn(app.timeZone(), now));
	const allowed = $derived(app.can('records.view'));

	let items = $state<Obligation[]>([]);
	let loaded = $state(false);
	async function load() {
		try {
			items = await loadUpcoming(30);
		} catch {
			items = [];
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		if (!allowed) return;
		void load();
		return app.onEvent('records.', () => void load());
	});
	const coming = $derived(
		items.filter((o) => {
			const status = dueStatus(o, today);
			return status === 'soon' || status === 'ok';
		}),
	);
	const shown = $derived(coming.slice(0, 4));
	// Reports once loaded (or at once when not allowed): the page waits for the first report.
	$effect(() => {
		if (allowed && !loaded) return;
		report({ count: allowed ? coming.length : 0, quietKey: 'records:quiet_coming_up' });
	});
</script>

{#if allowed}
	{#each shown as o (o.id)}
		<TodayRow
			variant="outline"
			icon={CalendarClock}
			title={o.title}
			meta={`${o.recordName} · ${dueLabel(o, today, t, app.dateLocale())}`}
			metaTone={dueStatus(o, today) === 'soon' ? 'heat' : 'soft'}
			{...o.recordUrl ? { href: o.recordUrl } : {}}
		/>
	{/each}
{/if}
