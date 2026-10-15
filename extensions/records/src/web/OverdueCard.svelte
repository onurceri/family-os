<script lang="ts">
	import { todayIn } from '@famos/time';
	import { TodayRow } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import { CalendarClock } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import type { Obligation } from '../contract/index.js';
	import { loadUpcoming } from './data.js';
	import { useRecords } from './i18n.js';
	import { dueLabel, dueStatus } from './status.js';

	/** Today, Needs you: obligations that are overdue, across all records. */
	let { size, report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useRecords();
	let now = $state(Date.now());
	const clock = setInterval(() => (now = Date.now()), 60_000);
	onDestroy(() => clearInterval(clock));
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
	const late = $derived(items.filter((o) => dueStatus(o, today) === 'overdue'));
	const shown = $derived(late.slice(0, 4));
	// Reports once loaded (or at once when not allowed): the page waits for the first report.
	$effect(() => {
		if (allowed && !loaded) return;
		report({ count: allowed ? late.length : 0, quietKey: '', urgent: late.length });
	});
</script>

{#if allowed && size !== 'line'}
	{#each shown as o (o.id)}
		<TodayRow
			variant="needs"
			icon={CalendarClock}
			title={o.title}
			meta={`${o.recordName} · ${dueLabel(o, today, t, app.dateLocale())}`}
			metaTone="attention"
			{...o.recordUrl ? { href: o.recordUrl } : {}}
		/>
	{/each}
	{#if late.length > shown.length}
		<p class="text-ink-soft px-4 py-3 text-sm font-semibold">
			{t('coming_up_more', { count: late.length - shown.length })}
		</p>
	{/if}
{/if}
