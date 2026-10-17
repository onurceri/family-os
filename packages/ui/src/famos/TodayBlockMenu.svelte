<script lang="ts">
	import ActionSheet from './ActionSheet.svelte';
	import IconButton from './IconButton.svelte';
	import Menu from './Menu.svelte';
	import type { MenuItem } from './menu-items.js';
	import { getTodayBlock } from './today-block.js';
	import { wide } from './wide.svelte.js';

	/**
	 * The `...` at the end of a Today block's label: "Hide from
	 * Today". A menu from the button on wide windows, an action sheet from the bottom on phones and
	 * tablets. Renders nothing outside a `TodayBlock` that may be hidden.
	 */
	const context = getTodayBlock();
	const block = $derived(context?.());
	let sheet = $state(false);

	const items = $derived<MenuItem[]>(
		block
			? [{ id: 'hide', label: block.hideLabel, icon: hideIcon, onselect: () => block.hide() }]
			: [],
	);
</script>

{#snippet dots()}
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="size-4"
		><circle cx="5" cy="12" r="1.75" /><circle cx="12" cy="12" r="1.75" /><circle
			cx="19"
			cy="12"
			r="1.75"
		/></svg
	>
{/snippet}

{#snippet hideIcon()}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		class="size-4"
		><path
			d="M10.7 5.1A10 10 0 0 1 21.9 12a10.7 10.7 0 0 1-1.9 2.8M6.6 6.6A10.7 10.7 0 0 0 2.1 12a10 10 0 0 0 13.3 5.3M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"
		/></svg
	>
{/snippet}

{#if block}
	<span class="today-block-menu" data-testid="today-block-menu">
		{#if wide.current}
			<Menu label={block.menuLabel} {items}>
				{#snippet trigger({ attrs })}
					<IconButton label={block.menuLabel} size="sm" {...attrs}>{@render dots()}</IconButton>
				{/snippet}
			</Menu>
		{:else}
			<IconButton label={block.menuLabel} size="sm" onclick={() => (sheet = true)}
				>{@render dots()}</IconButton
			>
			<ActionSheet bind:open={sheet} title={block.name} {items} cancelLabel={block.cancelLabel} />
		{/if}
	</span>
{/if}

<style>
	/* A 36 px button in a 24 px label row: it does not make the row taller. */
	.today-block-menu {
		display: inline-flex;
		flex: none;
		align-self: center;
		margin-block: -6px;
		color: var(--ink-soft);
		transition: opacity 120ms;
	}
	/* With a mouse, the ⋯ shows while its section is hovered or holds the focus, or while its
	   menu is open; it is only transparent, so keyboards and screen readers still reach it. On
	   touch it is always there. (Hovering or focusing an inner section also counts for the outer
	   ones, so any section around it that is not hovered is its own.) */
	@media (hover: hover) and (pointer: fine) {
		:global(section:not(:hover, :focus-within))
			.today-block-menu:not(:has([aria-expanded='true'])) {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.today-block-menu {
			transition: none;
		}
	}
</style>
