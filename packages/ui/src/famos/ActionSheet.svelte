<script lang="ts">
	import { tick } from 'svelte';
	import { focusFirst, trapTab } from './focus.js';
	import type { MenuItem } from './menu-items.js';

	/**
	 * The phone version of a Menu: rises from the bottom with the
	 * item's name as title, 48 px actions and a Cancel row. A modal dialog: focus moves in, Tab is
	 * trapped, Escape or the scrim closes, focus returns to what opened it.
	 */
	let {
		open = $bindable(false),
		title,
		items,
		cancelLabel,
		onclose,
	}: {
		open?: boolean;
		/** The item's name (already translated). */
		title: string;
		items: MenuItem[];
		cancelLabel: string;
		onclose?: () => void;
	} = $props();

	let panel = $state<HTMLElement>();
	let opener: HTMLElement | null = null;
	const id = $props.id();

	function close() {
		open = false;
		onclose?.();
	}

	$effect(() => {
		if (!open) return;
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		void tick().then(() => panel && focusFirst(panel));
		return () => {
			if (opener?.isConnected) opener.focus();
			opener = null;
		};
	});

	function onkeydown(e: KeyboardEvent) {
		if (!open || !panel) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else trapTab(panel, e);
	}

	function pick(item: MenuItem) {
		if (item.disabled) return;
		close();
		item.onselect();
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div class="scrim" onclick={close}></div>
	<div
		bind:this={panel}
		role="dialog"
		aria-modal="true"
		aria-labelledby="{id}-t"
		tabindex="-1"
		class="sheet"
		{onkeydown}
	>
		<h2 id="{id}-t" class="ttl">{title}</h2>
		<div class="list">
			{#each items as item (item.id)}
				<button
					type="button"
					class:danger={item.danger}
					disabled={item.disabled}
					onclick={() => pick(item)}
				>
					{#if item.icon}<span class="ic" aria-hidden="true">{@render item.icon()}</span>{/if}
					{item.label}
				</button>
			{/each}
		</div>
		<button type="button" class="cancel" onclick={close}>{cancelLabel}</button>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: var(--sheet-scrim);
		animation: fade 200ms ease-out;
	}
	.sheet {
		position: fixed;
		inset-inline: 0;
		bottom: 0;
		z-index: 61;
		display: grid;
		gap: 2px;
		max-height: 85dvh;
		overflow: auto;
		padding: 8px 8px calc(20px + env(safe-area-inset-bottom));
		background: var(--surface);
		border-radius: 18px 18px 0 0;
		box-shadow: var(--shadow-sheet);
		outline: none;
		animation: rise 240ms ease-out;
	}
	@media (min-width: 640px) {
		.sheet {
			inset-inline: auto;
			inset-inline-start: 50%;
			width: 420px;
			translate: -50% 0;
		}
	}
	.ttl {
		margin: 0;
		padding: 10px 12px 6px;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}
	.list {
		display: grid;
		gap: 2px;
	}
	button {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
		padding: 0 12px;
		border: 0;
		border-radius: 12px;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: 16px;
		font-weight: 600;
		text-align: start;
		cursor: pointer;
	}
	button:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--info);
	}
	button:disabled {
		opacity: 0.45;
	}
	.danger {
		color: var(--destructive);
	}
	.ic {
		display: inline-flex;
	}
	.ic :global(svg) {
		width: 18px;
		height: 18px;
	}
	.cancel {
		justify-content: center;
		margin-top: 6px;
		background: var(--idle);
	}
	@keyframes rise {
		from {
			transform: translateY(100%);
		}
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@media (min-width: 640px) {
		@keyframes rise {
			from {
				opacity: 0;
			}
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet,
		.scrim {
			animation: none;
		}
	}
</style>
