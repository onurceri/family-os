<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	/**
	 * A square icon button: 36 px (`sm`), `--ctl` (40 or 44) or
	 * 44 px (`lg`). On a mouse the hit area grows to 44 px through an invisible margin. `label` is
	 * the accessible name and the tooltip: name the item (`Options for Clio`).
	 */
	let {
		label,
		variant = 'ghost',
		size = 'md',
		round = false,
		children,
		class: className = '',
		...rest
	}: {
		label: string;
		variant?: 'ghost' | 'outline' | 'secondary' | 'primary';
		size?: 'sm' | 'md' | 'lg';
		round?: boolean;
		children: Snippet;
		class?: string;
	} & Omit<HTMLButtonAttributes, 'children' | 'aria-label'> = $props();
</script>

<button
	type="button"
	aria-label={label}
	title={label}
	class="ib {variant} {size} {className}"
	class:round
	{...rest}
>
	{@render children()}
</button>

<style>
	.ib {
		position: relative;
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--ctl);
		height: var(--ctl);
		padding: 0;
		border: 0;
		/* The ring is drawn with a shadow on :focus-visible only; no outline from the base styles. */
		outline: none;
		border-radius: var(--r-ctl);
		background: transparent;
		color: var(--ink-soft);
		cursor: pointer;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out;
	}
	.ib::after {
		content: '';
		position: absolute;
		inset: -4px;
	}
	.sm {
		width: 36px;
		height: 36px;
	}
	.lg {
		width: 44px;
		height: 44px;
	}
	.round {
		border-radius: 999px;
	}
	.ib :global(svg) {
		width: 20px;
		height: 20px;
	}
	.ghost:hover,
	.outline:hover {
		background: var(--idle);
		color: var(--ink);
	}
	.outline {
		color: var(--ink);
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.secondary {
		background: var(--idle);
		color: var(--ink);
	}
	.primary {
		background: var(--ink);
		color: var(--surface);
	}
	.ib:disabled {
		opacity: 0.45;
		pointer-events: none;
	}
	.ib:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	@media (prefers-reduced-motion: reduce) {
		.ib {
			transition: none;
		}
	}
</style>
