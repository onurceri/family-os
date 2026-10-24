<script lang="ts">
	import { Page, PageHeader, PageTabs, openPath } from '@famos/ui/famos';
	import type { Snippet } from 'svelte';
	import { useKitchen } from './i18n.js';

	/** The frame of the kitchen pages: title and the two tabs. */
	let {
		tab,
		headerActions,
		children,
	}: {
		tab: 'recipes' | 'plan';
		headerActions?: Snippet;
		children: Snippet;
	} = $props();
	const { app, t } = useKitchen();

	const TABS = ['recipes', 'plan'] as const;
	const HREF = { recipes: '/kitchen', plan: '/kitchen/plan' } as const;
</script>

<Page template="list-detail">
	<PageHeader title={t('title')}>
		{#snippet actions()}
			{#if headerActions}{@render headerActions()}{/if}
		{/snippet}
	</PageHeader>

	<div class="grid gap-4">
		{#if !app.can('kitchen.view')}
			<div class="bg-idle grid gap-1 rounded-xl p-4">
				<p class="font-bold">{t('no_access')}</p>
			</div>
		{:else}
			<PageTabs
				label={t('tabs_label')}
				current={tab}
				onselect={(id) => openPath(HREF[id as (typeof TABS)[number]])}
				tabs={TABS.map((id) => ({ id, label: t(`tab_${id}`) }))}
			/>
			{@render children()}
		{/if}
	</div>
</Page>
