<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	/**
	 * A standalone row on the wall: 48 px, 56 with a
	 * subtitle, title 15/600. Lit (`surface` + `shadow-lit`) by default; `idle` recedes into the wall;
	 * `selected` adds a 2 px `ink` inset ring and `aria-current`; `done` strikes the title. Renders
	 * a link when `href` is set, a button when `onclick` is set, otherwise a div.
	 */
	let {
		title,
		subtitle,
		idle = false,
		selected = false,
		done = false,
		href,
		onclick,
		lead,
		trail,
		children,
		class: className = '',
		...rest
	}: {
		title: string;
		subtitle?: string;
		idle?: boolean;
		selected?: boolean;
		done?: boolean;
		href?: string;
		onclick?: (event: MouseEvent) => void;
		/** Leading visual: an Avatar or a colored disc with an icon. */
		lead?: Snippet;
		/** Trailing content: pill, button, chevron. */
		trail?: Snippet;
		/** Extra content below the row (e.g. an inline form). */
		children?: Snippet;
		class?: string;
	} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'onclick'> = $props();

	const receded = $derived(idle);
	const interactive = $derived(Boolean(href || onclick));
	const current = $derived(selected ? (href ? 'page' : 'true') : undefined);
</script>

{#snippet body()}
	{#if lead}<span class="lead">{@render lead()}</span>{/if}
	<span class="txt">
		<span class="title" class:done>{title}</span>
		{#if subtitle}<span class="meta">{subtitle}</span>{/if}
	</span>
	{#if trail}<span class="end">{@render trail()}</span>{/if}
	{#if children}<div class="more">{@render children()}</div>{/if}
{/snippet}

{#if href}
	<a
		{href}
		class="tile {className}"
		class:two={Boolean(subtitle)}
		class:idle={receded}
		class:selected
		class:interactive
		aria-current={current}
		{...rest}>{@render body()}</a
	>
{:else if onclick}
	<button
		type="button"
		{onclick}
		class="tile {className}"
		class:two={Boolean(subtitle)}
		class:idle={receded}
		class:selected
		class:interactive
		aria-current={current}
		{...rest}>{@render body()}</button
	>
{:else}
	<div
		class="tile {className}"
		class:two={Boolean(subtitle)}
		class:idle={receded}
		class:selected
		aria-current={current}
		{...rest}
	>
		{@render body()}
	</div>
{/if}

<style>
	.tile {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		min-height: 48px;
		padding: 6px 12px;
		border: 0;
		border-radius: var(--r-item);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-lit);
		font: inherit;
		text-align: start;
		transition: background-color 150ms ease-out;
	}
	.two {
		min-height: 56px;
	}
	.idle {
		background: var(--idle);
		box-shadow: none;
	}
	.selected {
		box-shadow:
			var(--shadow-lit),
			inset 0 0 0 2px var(--ink);
	}
	.idle.selected {
		box-shadow: inset 0 0 0 2px var(--ink);
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
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title.done {
		color: var(--ink-soft);
		font-weight: 500;
		text-decoration: line-through;
	}
	.meta {
		overflow: hidden;
		color: var(--ink-soft);
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.end {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
	}
	.more {
		width: 100%;
	}
	.interactive {
		cursor: pointer;
	}
	@media (hover: hover) {
		.interactive:hover {
			background: color-mix(in oklab, var(--surface) 94%, var(--ink));
		}
		.idle.interactive:hover {
			background: color-mix(in oklab, var(--idle) 92%, var(--ink));
		}
	}
	.interactive:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	@media (prefers-reduced-motion: reduce) {
		.tile {
			transition: none;
		}
	}
</style>
