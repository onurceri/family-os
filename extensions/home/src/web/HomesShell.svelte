<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { EmptyState, Fab, ListDetail, ViewOnly } from '@famos/ui/famos';
	import { Plus } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { useHome } from './i18n.js';
	import HomesList from './HomesList.svelte';

	/**
	 * The Home page frame: title and "Add home" (the head button on windows from 768 px, a
	 * floating button on phones), the list, and the chosen home. The add form lives in the
	 * panel or sheet and is reflected as `?new=1`.
	 */
	let { selectedId = '', item }: { selectedId?: string; item?: Snippet } = $props();
	const { app, t } = useHome();
	// Also for people who may only suggest a home: theirs waits for approval.
	const mayAdd = $derived(app.access('home.addHome') !== 'no');
	const adding = $derived(app.query().get('new') === '1');
	let empty = $state(false);
	let first = $state<string | undefined>();
	let count = $state(0);
	const setAdding = (on: boolean) => app.setQuery({ new: on ? '1' : null }, { replace: !on });
</script>

{#snippet add()}
	{#if mayAdd}
		<Button class="max-md:hidden" onclick={() => setAdding(true)}
			><Plus class="size-4" />{t('add_home')}</Button
		>
	{:else}
		<ViewOnly label={app.t('app:view_only')} hint={app.t('app:view_only_hint')} />
	{/if}
{/snippet}

<ListDetail
	title={t('title')}
	actions={empty ? undefined : add}
	selected={Boolean(selectedId)}
	empty={empty && !adding}
	{first}
	{count}
>
	{#snippet emptyState()}
		<EmptyState art="home" title={t('empty')} hint={t('empty_hint')}>
			{#if mayAdd}
				<Button onclick={() => setAdding(true)}><Plus class="size-4" />{t('add_home')}</Button>
			{/if}
		</EmptyState>
	{/snippet}
	{#snippet list()}<HomesList
			{selectedId}
			{adding}
			onclosepanel={() => setAdding(false)}
			bind:empty
			bind:first
			bind:count
		/>{/snippet}
	{#snippet detail()}{#if item}{@render item()}{/if}{/snippet}
</ListDetail>

{#if mayAdd && !empty && !selectedId}
	<div class="md:hidden" style="--fab-bottom: 4.25rem">
		<Fab label={t('add_home')} onclick={() => setAdding(true)} hidden={adding} />
	</div>
{/if}
