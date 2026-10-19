<script lang="ts">
	import { findApp, type AwaitedChange } from '../app-context.js';
	import { awaitingRowText } from './awaiting.js';

	/**
	 * A new entry that waits for approval (`app.awaitedNew`), as a quiet row in the list it would
	 * join: an hourglass where a saved row has its icon, what it is in soft ink, and "Waiting for
	 * approval" (or, for someone who may decide it, who asked), then the same facts a saved row of the
	 * list shows, so two waiting entries can be told apart. It opens nothing, so it has no hover
	 * or chevron: the suggestion is decided in Quick add.
	 */
	let {
		change,
		title,
		detail,
	}: {
		change: AwaitedChange;
		/** What it is, when the action has no presenter that titles it (already translated). */
		title?: string;
		/** What a saved row would show beside it (date, product, place), already translated. */
		detail?: string;
	} = $props();
	const app = findApp();
	const text = $derived(app ? awaitingRowText(app, change) : null);
</script>

{#if text}
	<div class="awaiting" data-testid="awaiting-row">
		<span class="disc" aria-hidden="true">
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.75"
				stroke-linecap="round"
				stroke-linejoin="round"
				><path
					d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"
				/></svg
			>
		</span>
		<span class="txt">
			<span class="title">{title || text.title}</span>
			<span class="meta">{detail ? `${text.meta} · ${detail}` : text.meta}</span>
		</span>
	</div>
{/if}

<style>
	.awaiting {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		width: 100%;
		min-width: 0;
		padding: 6px 12px;
		color: var(--ink-soft);
	}
	.disc {
		display: grid;
		flex: none;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 999px;
		border: 1.5px dashed var(--line);
	}
	.disc svg {
		width: 18px;
		height: 18px;
	}
	.txt {
		display: grid;
		min-width: 0;
		flex: 1;
		gap: 1px;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: 13px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
</style>
