<script lang="ts">
	import type { SlotProps } from '@famos/ui/slots';
	import { useNow } from '@famos/ui/now';
	import type { BoardNote } from '../contract/index.js';
	import { loadNotes } from './data.js';
	import { columnsFor, countFitting } from './display-board.js';
	import { useBoard } from './i18n.js';
	import NoteCard from './NoteCard.svelte';

	/**
	 * Family display page: the papers on the board, pinned first, then the newest, in a grid that
	 * fills the box. It shows as many as fit without scrolling and counts the rest. Never a link or
	 * a button, and a display never marks a note seen. It reads again each time it comes round.
	 */
	let { shown }: SlotProps['display.page'] = $props();
	const { app, t } = useBoard();

	const clock = useNow();
	const now = $derived(clock.current);

	let notes = $state<BoardNote[] | null>(null);
	let failed = $state(false);
	async function load() {
		try {
			notes = await loadNotes();
			failed = false;
		} catch {
			// Keep what is on screen; the next time round tries again.
			failed = true;
		}
	}
	// Notes end by themselves: read again now and then, as well as when the board changes.
	$effect(() => {
		if (!shown) return;
		void load();
		const refresh = setInterval(() => void load(), 5 * 60_000);
		return () => clearInterval(refresh);
	});
	$effect(() => app.onEvent('board.', () => void load()));

	/* ───────────── fitting the box ───────────── */

	let width = $state(0);
	let box = $state<HTMLDivElement>();
	let list = $state<HTMLUListElement>();
	let note = $state<HTMLParagraphElement>();
	/** How many papers fit; null until measured. Papers past it stay laid out (so measuring stays
	    stable) but are not drawn. */
	let fitting = $state<number | null>(null);

	function measure() {
		if (!box || !list) return;
		const bottoms = [...list.querySelectorAll<HTMLElement>('[data-cell]')].map(
			(paper) => paper.offsetTop + paper.offsetHeight,
		);
		fitting = countFitting(bottoms, box.clientHeight, note?.offsetHeight ?? 0);
	}
	let frame = 0;
	const later = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(measure);
	};
	// The box or the papers change size (a photo arrives, the window turns): measured again.
	$effect(() => {
		if (!box || !list) return;
		const observer = new ResizeObserver(later);
		observer.observe(box);
		observer.observe(list);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	});
	$effect(() => {
		void notes?.map((n) => `${n.id}${n.updatedAt}`).join();
		void width;
		later();
	});

	const items = $derived(notes ?? []);
	const left = $derived(fitting === null ? 0 : Math.max(items.length - fitting, 0));
</script>

<svelte:window bind:innerWidth={width} />

<div class="relative size-full" bind:this={box}>
	{#if notes === null}
		{#if failed}
			<p class="bg-idle text-ink-soft rounded-lg px-5 py-4 text-xl">{t('page_unavailable')}</p>
		{/if}
	{:else if items.length === 0}
		<p class="bg-idle text-ink-soft rounded-lg px-5 py-4 text-xl">{t('display_empty')}</p>
	{:else}
		<!-- Room above and beside for the pins, tape and the tilt of the papers. -->
		<ul
			bind:this={list}
			class="grid content-start gap-5 px-2 pt-4"
			style:grid-template-columns="repeat({columnsFor(width)}, minmax(0, 1fr))"
		>
			{#each items as item, i (item.id)}
				<li
					data-cell
					class="grid"
					style:visibility={fitting === null || i >= fitting ? 'hidden' : undefined}
				>
					<NoteCard note={item} {now} variant="display" />
				</li>
			{/each}
		</ul>
	{/if}
	<p
		bind:this={note}
		class="text-ink-soft absolute inset-x-0 bottom-0 px-1 text-lg font-semibold"
		class:invisible={left === 0}
	>
		{t('page_more', { count: left || 1 })}
	</p>
</div>
