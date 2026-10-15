<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { EmptyState, Fab, ListDetail } from '@famos/ui/famos';
	import { Plus } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { useVehicles } from './i18n.js';
	import VehiclesList from './VehiclesList.svelte';

	/**
	 * The Vehicles page frame: title and "Add vehicle" (the head button on windows from 768 px, a
	 * floating button on phones), the list, and the chosen vehicle. The add form lives in the
	 * panel or sheet and is reflected as `?new=1`.
	 */
	let { selectedId = '', item }: { selectedId?: string; item?: Snippet } = $props();
	const { app, t } = useVehicles();
	// Also for people who may only suggest a change: theirs waits for approval.
	const mayChange = $derived(app.mayChange('vehicles.edit'));
	const adding = $derived(app.query().get('new') === '1');
	let empty = $state(false);
	let first = $state<string | undefined>();
	let count = $state(0);
	const setAdding = (on: boolean) => app.setQuery({ new: on ? '1' : null }, { replace: !on });
</script>

{#snippet add()}
	{#if mayChange}
		<Button class="max-md:hidden" onclick={() => setAdding(true)}
			><Plus class="size-4" />{t('add_vehicle')}</Button
		>
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
		<EmptyState art="vehicles" title={t('empty')} hint={t('empty_hint')}>
			{#if mayChange}
				<Button onclick={() => setAdding(true)}><Plus class="size-4" />{t('add_vehicle')}</Button>
			{/if}
		</EmptyState>
	{/snippet}
	{#snippet list()}<VehiclesList
			{selectedId}
			{adding}
			onclosepanel={() => setAdding(false)}
			bind:empty
			bind:first
			bind:count
		/>{/snippet}
	{#snippet detail()}{#if item}{@render item()}{/if}{/snippet}
</ListDetail>

{#if mayChange && !empty && !selectedId}
	<div class="md:hidden" style="--fab-bottom: 4.25rem">
		<Fab label={t('add_vehicle')} onclick={() => setAdding(true)} hidden={adding} />
	</div>
{/if}
