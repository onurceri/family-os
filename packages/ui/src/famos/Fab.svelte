<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The floating add button on phone list pages: 56 px, `ink`,
	 * `shadow-pop`, right side, above the tab bar and the safe area (`--fab-bottom` is the tab
	 * bar's height, set by the shell). Hide it while a sheet is open or the keyboard is up.
	 */
	let {
		label,
		onclick,
		href,
		hidden = false,
		children,
	}: {
		label: string;
		onclick?: (event: MouseEvent) => void;
		href?: string;
		hidden?: boolean;
		/** The icon; a "+" when omitted. */
		children?: Snippet;
	} = $props();

	/**
	 * While shown, tell the toast how far to lift above the button: the button's top edge is
	 * `--fab-bottom + 72px` and the toast's base is `5.5rem`, so the lift is `--fab-bottom - 8px`
	 * (8 px gap). Set on the root only while mounted and shown; the toast reads it on phones.
	 */
	$effect(() => {
		if (hidden) return;
		const root = document.documentElement;
		root.style.setProperty('--fab-clearance', 'calc(var(--fab-bottom, 0px) - 8px)');
		return () => root.style.removeProperty('--fab-clearance');
	});
</script>

{#snippet icon()}
	{#if children}{@render children()}{:else}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg
		>
	{/if}
{/snippet}

{#if !hidden}
	{#if href}
		<a {href} class="fab" aria-label={label}>{@render icon()}</a>
	{:else}
		<button type="button" class="fab" aria-label={label} {onclick}>{@render icon()}</button>
	{/if}
{/if}

<style>
	.fab {
		position: fixed;
		inset-inline-end: calc(16px + env(safe-area-inset-right));
		bottom: calc(16px + var(--fab-bottom, 0px) + env(safe-area-inset-bottom));
		z-index: 30;
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--ink);
		color: var(--surface);
		box-shadow: var(--shadow-pop);
		cursor: pointer;
	}
	.fab :global(svg) {
		width: 24px;
		height: 24px;
	}
	.fab:focus-visible {
		outline: none;
		box-shadow:
			var(--shadow-pop),
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
</style>
