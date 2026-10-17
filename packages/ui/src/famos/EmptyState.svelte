<script lang="ts">
	import type { Snippet } from 'svelte';
	import EmptyArt from './EmptyArt.svelte';
	import type { EmptyArtName } from './empty-art.js';

	/**
	 * One shape for every empty page: a card of at most 420 px, a
	 * small drawing of the area (`art`, or a 52 px disc with an icon), a line saying what the page is
	 * for, a line on what to do, the primary action.
	 */
	let {
		title,
		hint,
		art,
		icon,
		children,
	}: {
		title: string;
		hint?: string;
		/** The area's drawing; it takes the place of the icon. */
		art?: EmptyArtName;
		icon?: Snippet;
		/** The primary action (a Button). */
		children?: Snippet;
	} = $props();
</script>

<div class="empty" data-testid="empty-state">
	{#if art}<span class="art"><EmptyArt name={art} /></span>
	{:else if icon}<span class="disc" aria-hidden="true">{@render icon()}</span>{/if}
	<h3>{title}</h3>
	{#if hint}<p>{hint}</p>{/if}
	{#if children}<div class="act">{@render children()}</div>{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: center;
		text-align: center;
		gap: 10px;
		padding: 32px 24px 36px;
		max-width: 420px;
		margin: 24px auto;
		background: var(--surface);
		border-radius: var(--r-card);
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.art {
		margin-bottom: 4px;
	}
	.disc {
		display: grid;
		place-items: center;
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: var(--idle);
		color: var(--ink);
	}
	.disc :global(svg) {
		width: 24px;
		height: 24px;
	}
	h3 {
		margin: 0;
		font-size: 17px;
		font-weight: 700;
		text-wrap: balance;
	}
	p {
		margin: 0;
		max-width: 34ch;
		font-size: 14px;
		line-height: 1.45;
		color: var(--ink-soft);
		text-wrap: pretty;
	}
	.act {
		margin-top: 6px;
	}
</style>
