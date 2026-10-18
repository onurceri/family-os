<script lang="ts">
	import { Card, Row, Section } from '@famos/ui/famos';
	import { onDestroy, onMount } from 'svelte';
	import type { SwitchEntry } from '../contract/index.js';
	import { loadHistory } from './data.js';
	import { describeSwitch } from './history-words.js';
	import { useHomeAssistant } from './i18n.js';
	import { timeWords } from './words.js';

	/**
	 * Who switched what, in words, newest first: for the whole home under its own heading on the
	 * settings page, or for one item inside its sheet (`itemId`). It only reads, so everyone who
	 * sees the page sees it, whether or not they may switch.
	 */
	let {
		itemId,
		limit,
		framed = true,
	}: {
		itemId?: string;
		limit: number;
		/** Under a heading of its own (hidden while empty), or bare with an empty line. */
		framed?: boolean;
	} = $props();
	const { app, t } = useHomeAssistant();

	let entries = $state<SwitchEntry[]>([]);
	let loaded = $state(false);

	async function load() {
		try {
			entries = (await loadHistory({ itemId, limit })).entries;
			loaded = true;
		} catch {
			// Keep what is shown; the next event or visit reads it again.
		}
	}
	let off: (() => void) | undefined;
	onMount(() => {
		void load();
		off = app.onEvent('homeassistant.switches', () => void load());
	});
	onDestroy(() => off?.());

	const memberName = (memberId: string | null) =>
		memberId ? (app.members().find((m) => m.id === memberId)?.displayName ?? null) : null;
	const say = (entry: SwitchEntry) =>
		describeSwitch(entry, {
			t: (key, params) => t(key, params),
			member: memberName,
			time: (at) => timeWords(at, Date.now(), app.dateLocale(), app.hourCycle(), app.timeZone()),
		});
</script>

{#snippet list()}
	<Card rows>
		{#each entries as entry (entry.id)}
			{@const words = say(entry)}
			<Row title={words.title} meta={words.meta} />
		{/each}
	</Card>
{/snippet}

{#if framed}
	{#if entries.length > 0}
		<Section label={t('history_label')}>{@render list()}</Section>
	{/if}
{:else if entries.length > 0}
	<div class="grid gap-1.5">
		<p class="text-ink-soft text-[13px] font-semibold">{t('history_item_label')}</p>
		{@render list()}
	</div>
{:else if loaded}
	<p class="text-ink-soft text-[13px]">{t('history_item_empty')}</p>
{/if}
