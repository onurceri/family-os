<script lang="ts">
	import { type Draft, loadAnswerDrafts } from './data.js';
	import DraftView from './DraftView.svelte';
	import { useAssistant } from './i18n.js';

	/**
	 * The suggestions one answer created, as normal draft cards. The app's line for each (`lines`)
	 * stands in for the cards only when they cannot be shown, so a suggestion is named once.
	 */
	let {
		messageId,
		ids,
		lines = [],
	}: { messageId: string; ids: readonly string[]; lines?: readonly string[] } = $props();
	const { app, t } = useAssistant();
	// Suggestions wait in the family's share page (Quick add), linked for those who may use it.
	const share = $derived(app.share());
	let drafts = $state<Draft[]>([]);
	let failed = $state(false);
	let loaded = $state(false);

	async function load() {
		try {
			drafts = await loadAnswerDrafts(messageId, ids);
			failed = false;
		} catch {
			failed = true;
		}
		loaded = true;
	}
	$effect(() => {
		void load();
		return app.onEvent('core.draft.', () => void load());
	});
</script>

<div class="mt-3 grid gap-3">
	{#each drafts as draft (draft.id)}
		<DraftView {draft} />
	{/each}
	{#if loaded && drafts.length === 0}
		{#each lines as line, i (i)}
			<p class="text-ink-soft text-sm">{line}</p>
		{/each}
		{#if failed || lines.length > 0}
			<p class="text-ink-soft text-sm">
				{#if lines.length === 0}{t('suggestion_created')}{/if}
				{#if share}
					{#if lines.length === 0}·{/if}
					<a href={share.path} class="font-semibold underline">{t('open_quick_add')}</a>
				{/if}
			</p>
		{/if}
	{/if}
</div>
