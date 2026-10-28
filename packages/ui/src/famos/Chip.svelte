<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { colorVars } from '../colors.js';

	/**
	 * A small rounded choice or shortcut. `filter`: idle, an ink ring when on (a toggle, aria-pressed).
	 * `member`: avatar in `lead`, the member `color` is the ring when on (a toggle). `preset`:
	 * outlined, a "+" in `lead`; it adds something when tapped (a plain button).
	 */
	let {
		variant = 'filter',
		on = false,
		color,
		count,
		lead,
		children,
		class: className = '',
		...rest
	}: {
		variant?: 'filter' | 'member' | 'preset';
		on?: boolean;
		/** Member colour (a CSS colour), used for the ring of a member chip. */
		color?: string;
		count?: number;
		lead?: Snippet;
		children: Snippet;
		class?: string;
	} & Omit<HTMLButtonAttributes, 'children'> = $props();
</script>

<button
	type="button"
	class="chip {variant} {className}"
	class:on={variant !== 'preset' && on}
	style={colorVars('m', color)}
	aria-pressed={variant === 'preset' ? undefined : on}
	{...rest}
>
	{#if lead}{@render lead()}{/if}
	{@render children()}
	{#if count !== undefined}<span class="n">{count}</span>{/if}
</button>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 36px;
		padding: 0 12px;
		border: 0;
		border-radius: 999px;
		background: var(--idle);
		color: var(--ink-soft);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out,
			box-shadow 150ms ease-out;
	}
	@media (pointer: coarse) {
		.chip {
			height: 40px;
		}
	}
	.on {
		background: var(--surface);
		color: var(--ink);
		box-shadow:
			var(--shadow-lit),
			inset 0 0 0 2px var(--ink);
	}
	.member {
		padding-inline-start: 4px;
	}
	.member.on {
		box-shadow:
			var(--shadow-lit),
			inset 0 0 0 2px var(--m, var(--ink));
	}
	.preset {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--line);
		color: var(--ink);
	}
	@media (hover: hover) {
		.preset:hover {
			background: var(--idle);
		}
	}
	.n {
		font-weight: 700;
		color: var(--ink-soft);
	}
	.chip :global(svg) {
		width: 16px;
		height: 16px;
	}
	.chip:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	@media (prefers-reduced-motion: reduce) {
		.chip {
			transition: none;
		}
	}
</style>
