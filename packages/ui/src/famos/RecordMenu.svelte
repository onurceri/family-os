<script lang="ts">
	import IconButton from './IconButton.svelte';
	import Menu from './Menu.svelte';
	import type { MenuItem } from './menu-items.js';

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
</script>

<Menu {label} title={name} {cancelLabel} {items}>
	{#snippet trigger({ attrs })}
		<IconButton {label} variant="outline" {...attrs}
			><svg
				class="size-5"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle
					cx="5"
					cy="12"
					r="1"
				/>
			</svg></IconButton
		>
	{/snippet}
</Menu>
