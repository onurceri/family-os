<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { Button } from '../components/button/index.js';
	import { focusFirst, trapTab } from './focus.js';

	/**
	 * The form container on phones and tablets: full height from
	 * 12 px below the top, radius 14, a grab handle and a bar with Cancel, the title and Save. A
	 * `half` sheet (at most 85 %) is for pickers. A modal dialog: focus moves to the first field,
	 * Tab is trapped, Escape or the scrim asks `onclose`, focus returns to what opened it. Omit
	 * `onsave` for a sheet without a Save button (a picker).
	 */
	let {
		open,
		title,
		onclose,
		onsave,
		cancelLabel,
		saveLabel,
		saveDisabled = false,
		half = false,
		testid,
		children,
	}: {
		open: boolean;
		title: string;
		/** Cancel, Escape, the scrim. The page decides whether to ask about unsaved changes. */
		onclose: () => void;
		onsave?: () => void;
		cancelLabel: string;
		saveLabel?: string;
		saveDisabled?: boolean;
		half?: boolean;
		/** A `data-testid` for the sheet element. */
		testid?: string;
		children: Snippet;
	} = $props();

	const id = $props.id();
	let panel = $state<HTMLElement>();
	let opener: HTMLElement | null = null;

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
		if (e.key === 'Escape' && !e.defaultPrevented) {
			e.preventDefault();
			e.stopPropagation();
			onclose();
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && onsave && !saveDisabled) {
			e.preventDefault();
			onsave();
		} else trapTab(panel, e);
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div class="scrim" onclick={onclose}></div>
	<div
		bind:this={panel}
		role="dialog"
		aria-modal="true"
		aria-labelledby="{id}-t"
		tabindex="-1"
		class="sheet"
		class:half
		data-testid={testid}
		data-surface="card"
		{onkeydown}
	>
		{#if !half}<span class="grab" aria-hidden="true"></span>{/if}
		<header class="bar">
			<span class="l"
				><Button variant="ghost" size="sm" onclick={onclose}>{cancelLabel}</Button></span
			>
			<h2 id="{id}-t">{title}</h2>
			<span class="r"
				>{#if onsave && saveLabel}<Button
						variant="primary"
						size="sm"
						disabled={saveDisabled}
						onclick={onsave}>{saveLabel}</Button
					>{/if}</span
			>
		</header>
		<div class="body">{@render children()}</div>
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
		top: 12px;
		bottom: 0;
		z-index: 61;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		margin-inline: auto;
		background: var(--surface);
		color: var(--ink);
		border-radius: 14px 14px 0 0;
		box-shadow: var(--shadow-sheet);
		outline: none;
		animation: rise 240ms ease-out;
	}
	.half {
		top: auto;
		max-height: 85dvh;
		grid-template-rows: auto auto;
	}
	@media (min-width: 1024px) {
		.sheet {
			max-width: 32rem;
		}
	}
	.grab {
		position: absolute;
		top: 6px;
		left: 50%;
		width: 36px;
		height: 4px;
		margin-left: -18px;
		border-radius: 2px;
		background: var(--line);
	}
	.bar {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		min-height: 52px;
		padding: 0 8px;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		margin: 0;
		padding: 6px 8px;
		/* A long title takes the room Cancel and Save leave and wraps to two lines. */
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		overflow-wrap: anywhere;
		line-height: 1.25;
		font-size: 16px;
		font-weight: 800;
		text-align: center;
	}
	.r {
		justify-self: end;
	}
	.body {
		overflow: auto;
		padding: 16px 16px calc(24px + env(safe-area-inset-bottom));
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
	@media (prefers-reduced-motion: reduce) {
		.sheet {
			animation: fade 1ms;
		}
		.scrim {
			animation: none;
		}
	}
</style>
