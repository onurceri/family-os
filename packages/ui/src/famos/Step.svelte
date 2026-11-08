<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getStepsContext, stepState } from './steps.js';

	/**
	 * One numbered step of `Steps`: a marker (the number, a tick when done), the title, and either
	 * the open body (the current step) or one folded line (`summary` for a done step, nothing for
	 * one still to come).
	 */
	let {
		n,
		title,
		summary,
		children,
	}: {
		/** Its number, from 1. */
		n: number;
		title: string;
		/** The one line a done step keeps ("Code ABCD-EFGH"). */
		summary?: string;
		/** What the open step shows: a sentence, a field, its one button. */
		children?: Snippet;
	} = $props();

	const steps = getStepsContext();
	const state = $derived(stepState(n, steps.current));
	const canOpen = $derived(state === 'done' && steps.select !== undefined);
</script>

{#snippet head()}
	<span class="marker" aria-hidden="true">
		{#if state === 'done'}
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7" /></svg
			>
		{:else}{n}{/if}
	</span>
	<span class="text">
		<span class="title"
			>{title}{#if state === 'done' && steps.doneLabel}<span class="sr-only"
					>, {steps.doneLabel}</span
				>{/if}</span
		>
		{#if state === 'done' && summary}<span class="summary">{summary}</span>{/if}
	</span>
{/snippet}

<li
	class="step {state}"
	class:large={steps.large}
	aria-current={state === 'current' ? 'step' : undefined}
	data-state={state}
>
	{#if canOpen}
		<button type="button" class="head" onclick={() => steps.select?.(n)}>{@render head()}</button>
	{:else}
		<div class="head">{@render head()}</div>
	{/if}
	{#if state === 'current' && children}
		<div class="body">{@render children()}</div>
	{/if}
</li>

<style>
	.step {
		--marker: 28px;
		--gap: 12px;
		position: relative;
		display: grid;
		min-width: 0;
		padding-bottom: 16px;
	}
	.step.large {
		--marker: 52px;
		--gap: 20px;
		padding-bottom: 24px;
	}
	/* The thread from one marker to the next. */
	.step:not(:last-child)::before {
		content: '';
		position: absolute;
		top: calc(var(--marker) + 4px);
		bottom: 4px;
		inset-inline-start: calc(var(--marker) / 2 - 1px);
		width: 2px;
		border-radius: 1px;
		background: var(--line);
	}
	.head {
		display: flex;
		align-items: flex-start;
		gap: var(--gap);
		min-width: 0;
		width: 100%;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
	}
	button.head {
		cursor: pointer;
		border-radius: var(--r-item);
	}
	button.head:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--surface),
			0 0 0 4px var(--info);
	}
	@media (hover: hover) {
		button.head:hover .title {
			text-decoration: underline;
			text-underline-offset: 3px;
		}
	}
	.marker {
		display: grid;
		flex: none;
		place-items: center;
		width: var(--marker);
		height: var(--marker);
		border-radius: 50%;
		font-size: 0.875rem;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		background: var(--idle);
		color: var(--ink-soft);
	}
	.large .marker {
		font-size: 1.625rem;
	}
	.marker svg {
		width: 60%;
		height: 60%;
	}
	.current .marker {
		background: var(--ink);
		color: var(--surface);
	}
	.done .marker {
		background: var(--idle);
		color: var(--ink);
	}
	.text {
		display: grid;
		min-width: 0;
		flex: 1;
		gap: 1px;
		min-height: var(--marker);
		align-content: center;
	}
	.title {
		font-size: 0.9375rem;
		font-weight: 700;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.large .title {
		font-size: 1.75rem;
		line-height: 1.2;
	}
	.next .title {
		color: var(--ink-soft);
		font-weight: 600;
	}
	.summary {
		font-size: 0.8125rem;
		color: var(--ink-soft);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.large .summary {
		font-size: 1.25rem;
	}
	.body {
		display: grid;
		gap: 14px;
		min-width: 0;
		padding-top: 10px;
		padding-inline-start: calc(var(--marker) + var(--gap));
	}
	.large .body {
		gap: 20px;
		padding-top: 16px;
	}
</style>
