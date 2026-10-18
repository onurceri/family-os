<script lang="ts">
	import type { Snippet } from 'svelte';
	import { findApp, type AwaitedChange } from '../app-context.js';
	import { awaitingRowText } from './awaiting.js';
	import Row from './Row.svelte';

	/**
	 * A new entry that waits for approval (`app.awaitedNew`), as a quiet row in the list it would
	 * join: what it is, and "Waiting for approval" (or, for someone who may decide it, who asked).
	 * It opens nothing: the suggestion is decided in Quick add.
	 */
	let {
		change,
		title,
		lead,
	}: {
		change: AwaitedChange;
		/** What it is, when the action has no presenter that titles it (already translated). */
		title?: string;
		lead?: Snippet;
	} = $props();
	const app = findApp();
	const text = $derived(app ? awaitingRowText(app, change) : null);
</script>

{#if text}
	<Row title={title || text.title} meta={text.meta} idle {lead} data-testid="awaiting-row" />
{/if}
