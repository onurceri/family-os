<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import ActionSheet from './ActionSheet.svelte';
	import { menuSide } from './menu-place.js';
	import type { MenuItem } from './menu-items.js';
	import { wide } from './wide.svelte.js';

	/**
	 * The actions of a `...` button. `trigger` receives attributes to spread on the button that
	 * opens it. On wide windows a popover: `role="menu"`, the first item takes focus, arrow keys
	 * move (wrapping), Home and End jump, Escape closes and returns focus to the button, Tab and a
	 * click outside close it, and it opens toward the middle when its side would leave the window.
	 * On phones and tablets the same items rise as an ActionSheet, where a small popover is hard to
	 * hit and easily cut off, so no caller has to choose.
	 */
	let {
		items,
		label,
		title,
		cancelLabel,
		open = $bindable(false),
		align = 'end',
		trigger,
	}: {
		items: MenuItem[];
		/** Accessible name of the menu: name the item (`Options for Clio`). */
		label: string;
		/** The action sheet's title on phones: the item's name. `label` when not given. */
		title?: string;
		/** The action sheet's Cancel row (already translated). */
		cancelLabel: string;
		open?: boolean;
		align?: 'start' | 'end';
		trigger: Snippet<
			[
				{
					attrs: {
						'aria-haspopup': 'menu' | 'dialog';
						'aria-expanded': boolean;
						'aria-controls': string;
						onclick: () => void;
					};
					open: boolean;
				},
			]
		>;
	} = $props();

	const popover = $derived(wide.current);
	/** Set on open when the popover lined up with `align` would leave the window. */
	let flipped = $state(false);
	const side = $derived(flipped ? (align === 'start' ? 'end' : 'start') : align);
	const id = $props.id();
	let wrap = $state<HTMLElement>();
	let list = $state<HTMLElement>();
	let opener: HTMLElement | null = null;

	const buttons = () =>
		Array.from(list?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);

	function toggle() {
		if (open) close(true);
		else open = true;
	}

	function close(restore: boolean) {
		const target = opener;
		open = false;
		if (restore) void tick().then(() => target?.focus());
	}

	$effect(() => {
		if (!open || !popover) return;
		flipped = false;
		opener =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: (wrap?.querySelector<HTMLElement>('[aria-haspopup]') ?? null);
		void tick().then(() => {
			place();
			(buttons()[0] ?? list)?.focus();
		});
	});

	function place() {
		if (!wrap || !list) return;
		const anchor = wrap.getBoundingClientRect();
		flipped =
			menuSide({
				anchor: { left: anchor.left, right: anchor.right },
				width: list.offsetWidth,
				viewport: document.documentElement.clientWidth,
				preferred: align,
				dir: getComputedStyle(wrap).direction === 'rtl' ? 'rtl' : 'ltr',
			}) !== align;
	}

	function move(to: number) {
		const all = buttons();
		if (all.length === 0) return;
		all[(to + all.length) % all.length]?.focus();
	}

	function onkeydown(e: KeyboardEvent) {
		if (!open || !popover) return;
		const all = buttons();
		const at = all.indexOf(document.activeElement as HTMLElement);
		if (e.key === 'ArrowDown') (e.preventDefault(), move(at + 1));
		else if (e.key === 'ArrowUp') (e.preventDefault(), move(at < 0 ? -1 : at - 1));
		else if (e.key === 'Home') (e.preventDefault(), move(0));
		else if (e.key === 'End') (e.preventDefault(), move(-1));
		else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close(true);
		} else if (e.key === 'Tab') close(false);
	}

	function pick(item: MenuItem) {
		if (item.disabled) return;
		close(true);
		item.onselect();
	}

	function onwindowclick(e: MouseEvent) {
		if (open && popover && wrap && !wrap.contains(e.target as Node)) close(false);
	}
</script>

<svelte:window onclick={onwindowclick} />

<span class="wrap" bind:this={wrap} {onkeydown} role="presentation">
	{@render trigger({
		attrs: {
			'aria-haspopup': popover ? 'menu' : 'dialog',
			'aria-expanded': open,
			'aria-controls': `${id}-menu`,
			onclick: toggle,
		},
		open,
	})}
	{#if !popover}
		<ActionSheet bind:open title={title ?? label} {items} {cancelLabel} />
	{:else if open}
		<div
			bind:this={list}
			id="{id}-menu"
			role="menu"
			aria-label={label}
			tabindex="-1"
			class="menu {side}"
		>
			{#each items as item, i (item.id)}
				{#if item.danger && i > 0 && !items[i - 1]?.danger}
					<div class="sep" role="separator"></div>
				{/if}
				<button
					type="button"
					role="menuitem"
					tabindex="-1"
					class:danger={item.danger}
					disabled={item.disabled}
					onclick={() => pick(item)}
				>
					{#if item.icon}<span class="ic" aria-hidden="true">{@render item.icon()}</span>{/if}
					<span class="lbl">{item.label}</span>
					{#if item.kbd}<span class="kbd" aria-hidden="true">{item.kbd}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</span>

<style>
	.wrap {
		position: relative;
		display: inline-flex;
	}
	.menu {
		position: absolute;
		top: calc(100% + 6px);
		z-index: 50;
		display: grid;
		gap: 2px;
		min-width: 220px;
		padding: 6px;
		background: var(--surface);
		border-radius: var(--r-card);
		box-shadow:
			var(--shadow-pop),
			inset 0 0 0 1px var(--line);
		outline: none;
		transform-origin: top;
		animation: pop 120ms ease-out;
	}
	.end {
		inset-inline-end: 0;
	}
	.start {
		inset-inline-start: 0;
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: scale(0.97);
		}
	}
	.sep {
		height: 1px;
		margin: 4px 6px;
		background: var(--line);
	}
	button {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		padding: 0 10px;
		border: 0;
		border-radius: 10px;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		text-align: start;
		cursor: pointer;
	}
	button:hover,
	button:focus-visible {
		background: var(--idle);
		outline: none;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.danger {
		color: var(--destructive);
	}
	.ic {
		display: inline-flex;
		color: inherit;
	}
	.ic :global(svg) {
		width: 16px;
		height: 16px;
	}
	.lbl {
		flex: 1;
	}
	.kbd {
		font-size: 11px;
		font-weight: 700;
		color: var(--ink-soft);
		border: 1px solid var(--line);
		border-radius: 5px;
		padding: 0 5px;
		line-height: 17px;
	}
	@media (prefers-reduced-motion: reduce) {
		.menu {
			animation: none;
		}
	}
</style>
