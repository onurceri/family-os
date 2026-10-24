<script lang="ts">
	import { DisplayRow, DisplaySection } from '@famos/ui/famos';
	import { useNow } from '@famos/ui/now';
	import { StickyNote } from '@lucide/svelte';
	import type { BoardNote } from '../contract/index.js';
	import { loadNotes } from './data.js';
	import { useBoard } from './i18n.js';
	import NoteCard from './NoteCard.svelte';

	/**
	 * Family display widget: the notes on the board, pinned first, then the newest, in
	 * larger type. Read-only: nothing to touch, and a display never marks a note seen.
	 */
	let { rows }: { rows?: number } = $props();
	const { app, t } = useBoard();
	// Two papers: a display's column is short, and a third one was cut off at the bottom.
	const MAX = 2;
	/** A paper is about as tall as three rows: one paper when the display has room for fewer than six. */
	const max = $derived(rows === undefined || rows >= 6 ? MAX : 1);
	const clock = useNow();
	const now = $derived(clock.current);

	let notes = $state<BoardNote[]>([]);
	async function load() {
		try {
			notes = await loadNotes();
		} catch {
			// Keep what is on screen; the next refresh tries again.
		}
	}
	// Notes end by themselves: reload now and then, as well as when the board changes.
	$effect(() => {
		void load();
		const refresh = setInterval(() => void load(), 5 * 60_000);
		const off = app.onEvent('board.', () => void load());
		return () => {
			clearInterval(refresh);
			off();
		};
	});
</script>

<DisplaySection title={t('display_title')}>
	{#snippet icon()}<StickyNote class="text-sun" />{/snippet}
	{#if notes.length === 0}
		<DisplayRow variant="empty" title={t('display_empty')} />
	{:else}
		<ul class="grid gap-4 pt-1">
			{#each notes.slice(0, max) as note (note.id)}
				<li><NoteCard {note} {now} variant="display" /></li>
			{/each}
		</ul>
		{#if notes.length > max}<p class="text-ink-soft px-1 text-[13px]">+{notes.length - max}</p>{/if}
	{/if}
</DisplaySection>
