<script lang="ts">
	import type { SlotProps } from '@famos/ui/slots';
	import { type Draft, loadWaitingDrafts } from './data.js';
	import { useInbox } from './i18n.js';
	import NeedsDraftRow from './NeedsDraftRow.svelte';

	/**
	 * Today, Needs you: the suggestions waiting for this person's decision, decided in place; the
	 * same ones Quick add shows to decide and its badge counts. A person who may not approve (a
	 * supervised member) sees none of them as rows; they get one quiet line about their own.
	 */
	let { size, report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useInbox();
	let pending = $state<Draft[]>([]);
	let loaded = $state(false);

	async function load() {
		try {
			pending = (await loadWaitingDrafts()).toSorted((a, b) => a.createdAt - b.createdAt);
		} catch {
			pending = [];
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void load();
		const offDrafts = app.onEvent('core.draft.', () => void load());
		const offItems = app.onEvent('inbox.', () => void load());
		return () => {
			offDrafts();
			offItems();
		};
	});

	const canDecide = $derived(app.can('core.drafts.approve'));
	const mine = $derived(pending.filter((d) => d.canDecide));
	const shown = $derived(mine.slice(0, 5));
	// Reports only once loaded: the page waits for the first report.
	$effect(() => {
		if (!loaded) return;
		if (canDecide) report({ count: mine.length, quietKey: '', urgent: mine.length });
		else
			report({
				count: 0,
				quietKey: pending.length > 0 ? 'inbox:quiet_waiting_adult' : '',
				quietCount: pending.length,
			});
	});
</script>

{#if canDecide && size !== 'line'}
	{#each shown as draft (draft.id)}
		<NeedsDraftRow {draft} />
	{/each}
	{#if mine.length > shown.length}
		<a href="/add" class="text-ink-soft hover:text-ink block px-4 py-3 text-sm font-semibold"
			>{t('see_all', { count: mine.length })}</a
		>
	{/if}
{/if}
