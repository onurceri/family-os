<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A status pill, 24 px. Tinted tones put a 15 % tint of the
	 * state colour behind text that is the state colour mixed toward `ink` (65/35 for
	 * attention, now and info; 50/50 for heat and sun), so the text keeps 4.5:1 on its own tint in
	 * every bundled pack (packages/themes/test/pill-contrast.test.ts). `solid` is for done.
	 */
	let {
		tone = 'default',
		icon,
		children,
	}: {
		tone?: 'default' | 'now' | 'heat' | 'attention' | 'info' | 'sun' | 'solid';
		icon?: Snippet;
		children: Snippet;
	} = $props();
</script>

<span class="pill {tone}">
	{#if icon}{@render icon()}{/if}
	{@render children()}
</span>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 24px;
		padding: 0 9px;
		border-radius: 999px;
		font-size: 12px;
		font-weight: 700;
		white-space: nowrap;
		color: var(--ink);
		background: var(--idle);
	}
	.pill :global(svg) {
		width: 13px;
		height: 13px;
		stroke-width: 2.25;
	}
	.now {
		background: color-mix(in oklab, var(--now) 15%, transparent);
		color: color-mix(in oklab, var(--now) 65%, var(--ink));
	}
	.attention {
		background: color-mix(in oklab, var(--attention) 15%, transparent);
		color: color-mix(in oklab, var(--attention) 65%, var(--ink));
	}
	.info {
		background: color-mix(in oklab, var(--info) 15%, transparent);
		color: color-mix(in oklab, var(--info) 65%, var(--ink));
	}
	.heat {
		background: color-mix(in oklab, var(--heat) 15%, transparent);
		color: color-mix(in oklab, var(--heat) 50%, var(--ink));
	}
	.sun {
		background: color-mix(in oklab, var(--sun) 15%, transparent);
		color: color-mix(in oklab, var(--sun) 50%, var(--ink));
	}
	.solid {
		background: var(--now);
		color: var(--on-color);
	}
</style>
