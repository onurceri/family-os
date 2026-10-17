<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	/**
	 * A container: `surface` with a 1 px line and no shadow.
	 * `lit` has the shadow and no line (the one thing that matters on a page); `quiet` is `idle`.
	 * `rows` divides its children with 1 px lines. A card never contains a card.
	 */
	let {
		variant = 'plain',
		pad = false,
		rows = false,
		children,
		class: className = '',
		...rest
	}: {
		variant?: 'plain' | 'lit' | 'quiet';
		/** 16 x 20 padding, for a card that holds text instead of rows. */
		pad?: boolean;
		rows?: boolean;
		children?: Snippet;
		class?: string;
	} & HTMLAttributes<HTMLElement> = $props();
</script>

<div data-surface="card" class="card {variant} {className}" class:pad class:rows {...rest}>
	{@render children?.()}
</div>

<style>
	.card {
		background: var(--surface);
		border-radius: var(--r-card);
		box-shadow: inset 0 0 0 1px var(--line);
		color: var(--ink);
		min-width: 0;
	}
	.lit {
		box-shadow: var(--shadow-lit);
	}
	.quiet {
		background: var(--idle);
		box-shadow: none;
	}
	.pad {
		padding: 16px 20px;
	}
	.rows {
		display: grid;
	}
	/* More specific than a row's own `border: 0`, whatever order the styles load in. */
	.card.rows > :global(* + *) {
		border-top: 1px solid var(--line);
	}
</style>
