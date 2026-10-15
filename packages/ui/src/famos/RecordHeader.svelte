<script lang="ts">
	import type { Snippet } from 'svelte';
	import { findApp } from '../app-context.js';
	import AwaitingMark from './AwaitingMark.svelte';

	/**
	 * The head of a record page (design system v2 section 5.8): a 56 px disc (or photo), the name
	 * at the style's record size (26/800), one meta line of facts separated by
	 * dots with the members' avatars at the end, and `Edit` and a menu button at the right. Below
	 * 28 rem of container the actions move under the name. With `recordId`, the meta line says
	 * "Waiting for approval" while a change the viewer made to it waits for someone else.
	 */
	let {
		name,
		recordId,
		facts = [],
		icon,
		people,
		actions,
	}: {
		name: string;
		/** The record's id, to mark a change of the viewer's that waits for approval. */
		recordId?: string;
		/** Short facts such as the plate, the model, the fuel. Empty ones are left out. */
		facts?: (string | null | undefined)[];
		/** The 56 px disc content (an icon) or a photo. */
		icon?: Snippet;
		/** Avatars of the people it belongs to. */
		people?: Snippet;
		/** Edit (outline) and the menu button (outline icon). */
		actions?: Snippet;
	} = $props();

	const shown = $derived(facts.filter((f): f is string => Boolean(f)));
	const app = findApp();
	const awaiting = $derived(recordId !== undefined && (app?.awaitsApproval(recordId) ?? false));
</script>

<header class="rhead">
	{#if icon}<span class="disc" aria-hidden="true">{@render icon()}</span>{/if}
	<div class="txt">
		<h1 class="type-record">{name}</h1>
		{#if shown.length > 0 || people || awaiting}
			<p class="meta">
				{#each shown as fact, i (i)}
					{#if i > 0}<span class="sep" aria-hidden="true">&middot;</span>{/if}<span>{fact}</span>
				{/each}
				{#if people}<span class="pp">{@render people()}</span>{/if}
				{#if recordId}<AwaitingMark id={recordId} />{/if}
			</p>
		{/if}
	</div>
	{#if actions}<div class="act">{@render actions()}</div>{/if}
</header>

<style>
	.rhead {
		container-type: inline-size;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 16px;
		margin-bottom: 24px;
	}
	.disc {
		display: grid;
		place-items: center;
		flex: none;
		width: 56px;
		height: 56px;
		overflow: hidden;
		border-radius: 50%;
		background: var(--idle);
		color: var(--ink);
	}
	.disc :global(svg) {
		width: 26px;
		height: 26px;
	}
	.disc :global(img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.txt {
		display: grid;
		gap: 4px;
		min-width: 0;
		flex: 1 1 12rem;
	}
	h1 {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		margin: 0;
		font-size: 14px;
		color: var(--ink-soft);
	}
	.sep {
		opacity: 0.5;
	}
	.pp {
		display: inline-flex;
		margin-inline-start: 2px;
	}
	.act {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
	}
	/* Below 28 rem the actions go under the name, aligned with it. */
	@container (max-width: 28rem) {
		.act {
			flex-basis: 100%;
		}
	}
</style>
