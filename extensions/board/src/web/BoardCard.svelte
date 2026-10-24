<script lang="ts">
	import { TodaySection } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import { useNow } from '@famos/ui/now';
	import type { BoardNote } from '../contract/index.js';
	import { loadNotes } from './data.js';
	import { useBoard } from './i18n.js';
	import NoteCard from './NoteCard.svelte';

	/**
	 * Today, notes band: the board's papers (pinned first) as small papers in two columns, the
	 * same tilt, tape and inks as on the board; each one opens the board.
	 */
	let { size, report }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useBoard();
	const clock = useNow();
	const now = $derived(clock.current);
	const allowed = $derived(app.can('board.view'));

	let notes = $state<BoardNote[]>([]);
	let loaded = $state(false);
	async function load() {
		try {
			notes = await loadNotes();
		} catch {
			notes = [];
		} finally {
			loaded = true;
		}
	}
	// Reports only once loaded: the page keeps the last report while a card moves between columns.
	$effect(() => {
		if (!allowed) report({ count: 0, quietKey: 'board:quiet_board' });
		else if (loaded) report({ count: notes.length, quietKey: 'board:quiet_board' });
	});
	const limit = $derived(size === 'wide' ? 6 : 4);

	$effect(() => {
		if (!allowed) return;
		void load();
		return app.onEvent('board.', () => void load());
	});
</script>

{#if allowed && size !== 'line' && notes.length > 0}
	<TodaySection
		title={t('card_title')}
		count={String(notes.length)}
		href="/board"
		more={t('card_more')}
	>
		<div class="papers" data-testid="board-card">
			{#each notes.slice(0, limit) as note (note.id)}
				<a
					href="/board"
					class="item focus-visible:ring-ring block rounded-sm focus-visible:ring-2 focus-visible:outline-none"
				>
					<NoteCard {note} {now} variant="card" />
				</a>
			{/each}
		</div>
		{#if notes.length > limit}
			<a href="/board" class="text-ink-soft hover:text-ink px-1 text-sm font-semibold"
				>{t('card_and_more', { count: notes.length - limit })}</a
			>
		{/if}
	</TodaySection>
{/if}

<style>
	/* Two columns of papers, like the board itself; a pinned note's tape sticks out above. */
	.papers {
		columns: 2;
		column-gap: 0.75rem;
		padding: 0.25rem 0.25rem 0;
	}
	.item {
		break-inside: avoid;
		margin-bottom: 0.75rem;
		padding-top: 0.75rem;
	}
</style>
