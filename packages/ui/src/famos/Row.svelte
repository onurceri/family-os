<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	/**
	 * A line: 48 px, 56 with a meta line; leading visual, title,
	 * meta, trailing content. A link when `href` is set, a button when `onclick` is set, else a div.
	 * `tile` makes it a standalone row on the wall (lit, radius 12); `idle` a receded one.
	 */
	let {
		title,
		meta,
		href,
		onclick,
		tile = false,
		idle = false,
		selected = false,
		done = false,
		wrap = false,
		lead,
		trail,
		class: className = '',
		...rest
	}: {
		title: string;
		meta?: string;
		href?: string;
		onclick?: (event: MouseEvent) => void;
		tile?: boolean;
		idle?: boolean;
		selected?: boolean;
		done?: boolean;
		/** Long text and a wide trailing button: the button drops below the text when it does not fit. */
		wrap?: boolean;
		/** Leading visual: a disc, an Avatar, a check or an icon. */
		lead?: Snippet;
		/** Trailing content: pill, amount, small button, menu button, chevron. */
		trail?: Snippet;
		class?: string;
	} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'onclick'> = $props();

	const interactive = $derived(Boolean(href || onclick));
</script>

{#snippet body()}
	{#if lead}<span class="lead">{@render lead()}</span>{/if}
	<span class="txt">
		<span class="title" class:done>{title}</span>
		{#if meta}<span class="meta">{meta}</span>{/if}
	</span>
	{#if trail}<span class="end">{@render trail()}</span>{/if}
{/snippet}

{#if href}
	<a
		{href}
		class="row {className}"
		class:two={Boolean(meta)}
		class:tile
		class:idle
		class:selected
		class:interactive
		class:wrap
		aria-current={selected ? 'page' : undefined}
		{...rest}>{@render body()}</a
	>
{:else if onclick}
	<button
		type="button"
		{onclick}
		class="row {className}"
		class:two={Boolean(meta)}
		class:tile
		class:idle
		class:selected
		class:interactive
		class:wrap
		aria-current={selected ? 'true' : undefined}
		{...rest}>{@render body()}</button
	>
{:else}
	<div
		class="row {className}"
		class:two={Boolean(meta)}
		class:tile
		class:idle
		class:selected
		class:wrap
		data-interactive={interactive}
		{...rest}
	>
		{@render body()}
	</div>
{/if}

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
		width: 100%;
		padding: 6px 12px;
		min-width: 0;
		text-align: start;
		color: var(--ink);
		border: 0;
		background: none;
		font: inherit;
		transition: background-color 150ms ease-out;
	}
	.two {
		min-height: 56px;
	}
	.wrap {
		flex-wrap: wrap;
	}
	.wrap .txt {
		flex: 1 1 14rem;
	}
	.wrap .meta {
		white-space: normal;
		overflow: visible;
		text-overflow: clip;
	}
	.wrap .end {
		margin-inline-start: auto;
	}
	.lead {
		display: inline-flex;
		flex: none;
		align-items: center;
		color: var(--ink-soft);
	}
	.txt {
		display: grid;
		min-width: 0;
		flex: 1;
		gap: 1px;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.title.done {
		font-weight: 500;
		color: var(--ink-soft);
		text-decoration: line-through;
	}
	.meta {
		font-size: 13px;
		color: var(--ink-soft);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.end {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
	}
	.interactive {
		cursor: pointer;
	}
	@media (hover: hover) {
		.interactive:hover {
			background: var(--idle);
			background: color-mix(in oklab, var(--idle) 55%, transparent);
		}
	}
	.interactive:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	.tile {
		background: var(--surface);
		border-radius: var(--r-item);
		box-shadow: var(--shadow-lit);
	}
	.tile.idle {
		background: var(--idle);
		box-shadow: none;
	}
	.tile.idle .title {
		color: var(--ink);
	}
	.tile.selected {
		box-shadow:
			var(--shadow-lit),
			inset 0 0 0 2px var(--ink);
	}
	@media (prefers-reduced-motion: reduce) {
		.row {
			transition: none;
		}
	}
</style>
