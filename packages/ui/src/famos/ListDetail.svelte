<script lang="ts">
	import { type Snippet, untrack } from 'svelte';
	import { openPath } from './open-path.js';
	import Page from './Page.svelte';
	import PageHeader from './PageHeader.svelte';
	import { wide } from './wide.svelte.js';

	/**
	 * The "list and detail" page pattern, in the `list-detail`
	 * template's frame (`Page`, the standard width). The page title and its
	 * main action sit across the full width; below, a list column on the left (260 px at 1024-1279,
	 * 280 px above) and the chosen item on the right (the rest of the 1200 px frame). The selection lives in the URL,
	 * so the page passes `selected`.
	 *
	 * One rule for every page, so empty states look the same everywhere:
	 * - Nothing at all (`empty`): one centred empty state with the main action.
	 * - Something, nothing chosen, 1024 px and wider: with `first` (the address of the first item)
	 *   that item opens straight away, replacing this address so Back still leaves the page (after
	 *   leaving an item, only once the list's first item is a different one);
	 *   without it the list stands alone in one column. There is never a "choose on the left" hint.
	 * - With exactly one item (`count` is 1) there is no list column: the item is the page, until
	 *   there are two.
	 * - Below 1024 px only one side is shown: the list (with the header), or the item once chosen.
	 */
	let {
		title,
		subtitle,
		actions,
		selected,
		empty = false,
		emptyState,
		first,
		count,
		list,
		detail,
	}: {
		/** Omit when the list renders its own header. */
		title?: string;
		subtitle?: string;
		actions?: Snippet;
		selected: boolean;
		empty?: boolean;
		/** What the page shows with nothing at all: an `EmptyState`. */
		emptyState?: Snippet;
		/** Where the first item opens; it opens by itself on wide windows when nothing is chosen. */
		first?: string;
		/** How many items there are; with exactly one, wide windows show the item alone. */
		count?: number;
		list: Snippet;
		detail: Snippet;
	} = $props();

	/** Wide, with exactly one item chosen: the item is the page. */
	const single = $derived(wide.current && selected && count === 1);
	/** Wide, with an item chosen among several: the list beside it. */
	const split = $derived(wide.current && selected && count !== 1);

	// Leaving an item (archived, removed, or closed with Back) must not open the first item again
	// at once: the list may still hold the item that was left until its reload arrives, so the
	// first item is opened by itself only once it is a different one than when the person left.
	let wasSelected = false;
	let stale = $state<string | undefined>();
	$effect(() => {
		if (selected) wasSelected = true;
		else if (wasSelected) {
			wasSelected = false;
			stale = untrack(() => first);
		}
	});
	$effect(() => {
		if (wide.current && !selected && !empty && first && first !== stale)
			openPath(first, { replace: true });
	});
</script>

{#snippet header()}
	{#if title}<PageHeader {title} {subtitle} {actions} />{/if}
{/snippet}

{#snippet nothing()}
	{#if emptyState}{@render emptyState()}{/if}
{/snippet}

<Page template="list-detail">
	<!-- One tree for every layout: the list and the item keep their place when the layout changes
	     (the first item opening, a second item arriving), so neither is mounted, and loaded, twice. -->
	{#if wide.current || !selected}{@render header()}{/if}
	<div
		class={split
			? 'grid grid-cols-[260px_minmax(0,1fr)] items-start gap-6 xl:grid-cols-[280px_minmax(0,1fr)] xl:gap-8'
			: 'contents'}
	>
		{#if wide.current || !selected}
			<!-- With one item the list stays mounted (it keeps loading and owns the add panel) but shows no items. -->
			<div
				class="min-w-0"
				class:collapsed={single}
				data-testid={single ? 'single-item-list' : undefined}
			>
				{@render list()}
			</div>
		{/if}
		{#if selected}
			<!-- The item fills its side of the frame (at most 880 px beside the list, by the frame's
			     own width); alone, it is the page. -->
			<div class="min-w-0" data-testid={single ? 'single-item' : undefined}>
				{@render detail()}
			</div>
		{/if}
	</div>
	{#if empty && !selected}{@render nothing()}{/if}
</Page>

<style>
	.collapsed :global(ul),
	.collapsed :global(ol) {
		display: none;
	}
</style>
