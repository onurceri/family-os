<script lang="ts">
	import { ActionSheet, IconButton, Menu, type MenuItem, wide } from '@famos/ui/famos';
	import { Ellipsis } from '@lucide/svelte';

	/**
	 * The `...` button of a record's head: a menu from the
	 * button on wide windows, an action sheet from the bottom on phones and tablets.
	 */
	let {
		name,
		label,
		cancelLabel,
		items,
	}: {
		/** The record's name: the action sheet's title. */
		name: string;
		/** Accessible name of the button (name the record). */
		label: string;
		cancelLabel: string;
		items: MenuItem[];
	} = $props();

	let sheet = $state(false);
</script>

{#if wide.current}
	<Menu {label} {items}>
		{#snippet trigger({ attrs })}
			<IconButton {label} variant="outline" {...attrs}><Ellipsis class="size-5" /></IconButton>
		{/snippet}
	</Menu>
{:else}
	<IconButton {label} variant="outline" onclick={() => (sheet = true)}
		><Ellipsis class="size-5" /></IconButton
	>
	<ActionSheet bind:open={sheet} title={name} {items} {cancelLabel} />
{/if}
