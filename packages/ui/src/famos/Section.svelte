<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A section label on the wall: uppercase label, a plain count,
	 * actions at the right (ghost buttons), then its content (rows or a card).
	 */
	let {
		label,
		count,
		level = 2,
		actions,
		children,
	}: {
		label: string;
		/** A number, or a short text such as "412 this year". Plain text, never a badge. */
		count?: number | string;
		level?: 2 | 3;
		actions?: Snippet;
		children?: Snippet;
	} = $props();
	const id = $props.id();
</script>

<section class="sec" aria-labelledby="{id}-t">
	<div class="head">
		<svelte:element this={`h${level}`} id="{id}-t" class="label">{label}</svelte:element>
		{#if count !== undefined}<span class="count">{count}</span>{/if}
		{#if actions}<span class="actions">{@render actions()}</span>{/if}
	</div>
	{@render children?.()}
</section>

<style>
	.sec {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 8px;
		min-height: 24px;
	}
	.label {
		margin: 0;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-soft);
		line-height: 1.2;
	}
	.count {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-soft);
	}
	.actions {
		margin-inline-start: auto;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	/* Ghost buttons placed here get the section-action size: 32 px, 13 px text. */
	.actions :global(button),
	.actions :global(a) {
		min-height: 32px;
		font-size: 13px;
	}
</style>
