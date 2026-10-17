<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { EmptyState, Fab, ListDetail, ViewOnly } from '@famos/ui/famos';
	import { Plus } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { usePets } from './i18n.js';
	import PetsList from './PetsList.svelte';

	/**
	 * The Pets page frame: title and "Add pet" (the head button on windows from 768 px, a
	 * floating button on phones), the list, and the chosen pet. The add form lives in the
	 * panel or sheet and is reflected as `?new=1`.
	 */
	let { selectedId = '', item }: { selectedId?: string; item?: Snippet } = $props();
	const { app, t } = usePets();
	// Also for people who may only suggest a pet: theirs waits for approval.
	const mayAdd = $derived(app.access('pets.addPet') !== 'no');
	const adding = $derived(app.query().get('new') === '1');
	let empty = $state(false);
	let first = $state<string | undefined>();
	let count = $state(0);
	const setAdding = (on: boolean) => app.setQuery({ new: on ? '1' : null }, { replace: !on });
</script>

{#snippet add()}
	{#if mayAdd}
		<Button class="max-md:hidden" onclick={() => setAdding(true)}
			><Plus class="size-4" />{t('add_pet')}</Button
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
		<EmptyState art="pets" title={t('empty')} hint={t('empty_hint')}>
			{#if mayAdd}
				<Button onclick={() => setAdding(true)}><Plus class="size-4" />{t('add_pet')}</Button>
			{/if}
		</EmptyState>
	{/snippet}
	{#snippet list()}<PetsList
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
		<Fab label={t('add_pet')} onclick={() => setAdding(true)} hidden={adding} />
	</div>
{/if}
