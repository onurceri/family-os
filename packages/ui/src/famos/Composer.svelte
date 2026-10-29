<script lang="ts">
	/**
	 * The inline add field: a tile with a "+", a placeholder that
	 * teaches the syntax. Enter adds and keeps focus, Esc clears. With text, `onmore` shows an
	 * "Add details" link that opens the panel or sheet pre-filled.
	 */
	import { counterText, type LengthState, lengthState } from './length-limit.js';

	let {
		value = $bindable(''),
		placeholder,
		label,
		onsubmit,
		limit,
		tooLong,
		measure,
		note,
		onmore,
		moreLabel,
		disabled = false,
		size = 'md',
	}: {
		value?: string;
		placeholder: string;
		/** Accessible name of the field (already translated). */
		label: string;
		/**
		 * Called with the trimmed text on Enter; the field clears at once so the next entry can
		 * start. When it returns (or resolves to) `false`, or rejects, the text comes back unless
		 * the person has typed something else meanwhile.
		 */
		onsubmit: (text: string) => void | boolean | Promise<void | boolean>;
		/**
		 * Longest text that can be added. The field never cuts: a counter shows near the limit and
		 * a message over it, and Enter does nothing until the text is short enough.
		 */
		limit?: number;
		/**
		 * The message when over, e.g. "Too long: 212 characters. The limit is 160."; given the
		 * counter text ("212/160") and the length and limit themselves.
		 */
		tooLong?: (counter: string, usage: LengthState) => string;
		/** The part of the text the limit applies to, when it is not all of it (the longest item of several). */
		measure?: (text: string) => string;
		/** A quiet line under the field, e.g. what Enter is about to add; nothing when undefined. */
		note?: string;
		onmore?: (text: string) => void;
		moreLabel?: string;
		disabled?: boolean;
		/** `lg`: a 56 px round field, for a page whose main act is adding (shopping, tasks). */
		size?: 'md' | 'lg';
	} = $props();

	let input = $state<HTMLInputElement>();
	const limitState = $derived(limit ? lengthState(measure ? measure(value) : value, limit) : null);

	async function submit(text: string) {
		let kept = false;
		try {
			kept = (await onsubmit(text)) === false;
		} catch {
			kept = true;
		}
		if (kept && value === '') value = text;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.isComposing) {
			e.preventDefault();
			const text = value.trim();
			if (!text || limitState?.over) return;
			value = '';
			void submit(text);
		} else if (e.key === 'Escape' && value) {
			e.preventDefault();
			e.stopPropagation();
			value = '';
		}
	}
</script>

<div
	class="composer"
	class:lg={size === 'lg'}
	class:filled={value.length > 0}
	class:over={limitState?.over}
>
	<svg
		class="plus"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg
	>
	<input
		bind:this={input}
		bind:value
		type="text"
		enterkeyhint="done"
		autocomplete="off"
		aria-label={label}
		{placeholder}
		{disabled}
		aria-invalid={limitState?.over ? 'true' : undefined}
		{onkeydown}
	/>
	{#if onmore && moreLabel && value.trim()}
		<button
			type="button"
			class="more"
			onclick={() => {
				onmore?.(value.trim());
				input?.focus();
			}}>{moreLabel}</button
		>
	{/if}
	<span class="kbd" aria-hidden="true">{'\u21b5'}</span>
</div>
{#if limitState?.counting}
	<p class="limit" class:over={limitState.over} role={limitState.over ? 'alert' : undefined}>
		{limitState.over && tooLong
			? tooLong(counterText(limitState), limitState)
			: counterText(limitState)}
	</p>
{/if}
{#if note && !limitState?.over}
	<p class="limit note" title={note}>{note}</p>
{/if}

<style>
	.composer {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 48px;
		padding: 0 12px 0 14px;
		border-radius: var(--r-item);
		background: var(--surface);
		box-shadow: var(--shadow-lit);
		color: var(--ink-soft);
		transition: box-shadow 150ms ease-out;
	}
	.limit {
		margin: 4px 14px 0;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--ink-soft);
	}
	.note {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.limit.over {
		color: var(--attention);
		font-weight: 600;
	}
	.composer.over,
	.composer.over:focus-within {
		box-shadow:
			var(--shadow-lit),
			inset 0 0 0 1.5px var(--attention);
	}
	.lg {
		height: 56px;
		padding: 0 16px 0 20px;
		border-radius: 999px;
	}
	.lg input {
		font-size: 16px;
	}
	.lg .plus {
		width: 20px;
		height: 20px;
	}
	.composer:focus-within {
		box-shadow:
			var(--shadow-lit),
			inset 0 0 0 1.5px var(--info);
		color: var(--ink);
	}
	.plus {
		width: 18px;
		height: 18px;
		flex: none;
	}
	input {
		flex: 1;
		min-width: 0;
		height: 100%;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 15px;
	}
	input::placeholder {
		color: var(--ink-soft);
		opacity: 0.8;
	}
	.more {
		border: 0;
		background: none;
		padding: 0 4px;
		min-height: 32px;
		font: inherit;
		font-size: 13px;
		font-weight: 700;
		color: var(--info);
		white-space: nowrap;
		cursor: pointer;
	}
	.more:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--info);
		border-radius: 6px;
	}
	.kbd {
		display: none;
		font-size: 11px;
		font-weight: 700;
		color: var(--ink-soft);
		border: 1px solid var(--line);
		border-radius: 5px;
		padding: 0 5px;
		line-height: 17px;
		opacity: 0.7;
	}
	@media (hover: hover) and (pointer: fine) {
		.kbd {
			display: inline-block;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.composer {
			transition: none;
		}
	}
</style>
