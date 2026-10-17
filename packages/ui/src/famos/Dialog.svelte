<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { focusFirst, trapTab } from './focus.js';

	/**
	 * A centred modal for the few interrupts that must block:
	 * 400 px, 90 % on phones. A native `<dialog>` shown with `showModal()`: the page behind is
	 * inert; Tab is also trapped here, Escape asks `onclose`, and focus returns to what opened
	 * it. Put the safe choice first in `actions`, or mark it `data-autofocus`.
	 */
	let {
		open,
		title,
		onclose,
		description,
		children,
		actions,
	}: {
		open: boolean;
		title: string;
		onclose: () => void;
		description?: string;
		children?: Snippet;
		/** Right-aligned buttons: a ghost one and the consequence button. */
		actions?: Snippet;
	} = $props();

	const id = $props.id();
	let el = $state<HTMLDialogElement>();
	let opener: HTMLElement | null = null;

	$effect(() => {
		if (!open || !el) return;
		const dialog = el;
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (typeof dialog.showModal === 'function') {
			try {
				dialog.showModal();
			} catch {
				dialog.setAttribute('open', '');
			}
		} else dialog.setAttribute('open', '');
		void tick().then(() => focusFirst(dialog));
		return () => {
			if (typeof dialog.close === 'function') dialog.close();
			else dialog.removeAttribute('open');
			if (opener?.isConnected) opener.focus();
			opener = null;
		};
	});

	function onkeydown(e: KeyboardEvent) {
		if (!el) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		} else trapTab(el, e);
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<dialog
		bind:this={el}
		aria-labelledby="{id}-t"
		aria-describedby={description ? `${id}-d` : undefined}
		oncancel={(e) => {
			e.preventDefault();
			onclose();
		}}
		onclick={(e) => {
			if (e.target === el) onclose();
		}}
		{onkeydown}
	>
		<div class="box" data-surface="card">
			<h2 id="{id}-t">{title}</h2>
			{#if description}<p id="{id}-d">{description}</p>{/if}
			{@render children?.()}
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</div>
	</dialog>
{/if}

<style>
	dialog {
		width: min(400px, 90vw);
		max-width: none;
		max-height: 90dvh;
		margin: auto;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		overflow: visible;
	}
	dialog::backdrop {
		background: var(--sheet-scrim);
	}
	.box {
		display: grid;
		gap: 10px;
		padding: 24px;
		background: var(--surface);
		border-radius: var(--r-card);
		box-shadow: var(--shadow-pop);
		animation: pop 120ms ease-out;
	}
	h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 800;
	}
	p {
		margin: 0;
		font-size: 14px;
		line-height: 1.45;
		color: var(--ink-soft);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 10px;
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: scale(0.97);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.box {
			animation: none;
		}
	}
</style>
