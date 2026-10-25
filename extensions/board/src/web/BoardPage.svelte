<script lang="ts">
	import { EmptyState, Page, PageHeader, ViewOnly } from '@famos/ui/famos';
	import { useNow } from '@famos/ui/now';
	import { PenLine, X } from '@lucide/svelte';
	import { onDestroy, tick } from 'svelte';
	import type { BoardNote } from '../contract/index.js';
	import Composer from './Composer.svelte';
	import Garland from './Garland.svelte';
	import { loadNotes, markSeen, moveNote, notePhotoUrl, pinNote, removeNote } from './data.js';
	import { useBoard } from './i18n.js';
	import NoteCard from './NoteCard.svelte';
	import { type Box, gapAt, moveLocal, type Place, placeAt, stepPlace } from './order.js';

	/**
	 * The board itself, the kitchen cork wall: the whole page is cork (the theme's `board` token
	 * with a quiet texture) under a garland, and the notes are papers pinned or taped on it in
	 * columns. The first tile, a pad of sticky notes, writes a new note in place. Looking at the board marks
	 * the notes seen, once each. The author (or a manager) arranges notes by dragging them, with a
	 * mouse or a finger, or one step at a time from the note's menu.
	 */
	const { app, t } = useBoard();

	let notes = $state<BoardNote[]>([]);
	let loaded = $state(false);
	let loadError = $state(false);
	const clock = useNow();
	const now = $derived(clock.current);

	const canView = $derived(app.can('board.view'));
	// Posting and pinning, as the server decides them for this viewer; editing, moving and removing
	// a note also turn on who wrote it.
	const canPost = $derived(app.access('board.postNote') !== 'no');
	const canManage = $derived(app.access('board.pinNote') !== 'no');
	const me = $derived(app.me()?.id ?? null);

	let writing = $state(false);
	let editingId = $state<string | null>(null);
	let viewing = $state<BoardNote | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let opener: HTMLElement | null = null;

	/** Notes already reported as seen in this visit. */
	const reported = new Set<string>();

	async function load() {
		try {
			notes = await loadNotes();
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loaded = true;
		}
		// Looking at the board is seeing it; a note someone else wrote is reported once.
		if (!me || document.visibilityState === 'hidden') return;
		const unseen = notes
			.filter((note) => !note.seenBy.includes(me) && !reported.has(note.id))
			.map((note) => note.id);
		if (unseen.length === 0) return;
		for (const id of unseen) reported.add(id);
		void markSeen(unseen).catch(() => {
			for (const id of unseen) reported.delete(id);
		});
	}
	$effect(() => {
		if (!canView || app.offline()) return;
		void load();
		return app.onEvent('board.', () => void load());
	});

	const mayChange = (note: BoardNote) =>
		canManage || (canPost && me !== null && note.createdBy === me);

	async function pin(note: BoardNote) {
		try {
			await pinNote(note.id, !note.pinned);
			await load();
		} catch {
			app.toast(t('error'));
		}
	}
	async function remove(note: BoardNote) {
		try {
			await removeNote(note.id);
			app.toast(t('removed'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	/** Puts the note in its new place at once; the server's order follows with the next load. */
	async function commitMove(id: string, place: Place) {
		notes = moveLocal(notes, id, place);
		try {
			await moveNote(id, place);
		} catch {
			app.toast(t('error'));
			await load();
		}
	}

	let announcement = $state('');
	/** Move earlier or later from the menu; the focus stays on the note's menu. */
	async function step(note: BoardNote, by: -1 | 1) {
		const place = stepPlace(notes, note.id, by);
		if (!place) return;
		const moving = commitMove(note.id, place);
		announcement = '';
		await tick();
		announcement = t('moved');
		const item = boardEl?.querySelector<HTMLElement>(`[data-note-id="${note.id}"]`);
		const again = item?.querySelector<HTMLElement>(
			`[data-move="${by === -1 ? 'earlier' : 'later'}"]`,
		);
		(again ?? item?.querySelector<HTMLElement>('[data-menu]'))?.focus();
		await moving;
	}

	// Dragging: the note follows the pointer by `transform` only, and the boxes of the other notes
	// are measured once when it starts, so a pointer move reads no layout. A mouse drags after a
	// few pixels; a finger after holding the note for a moment (before that, it scrolls the page).
	let boardEl = $state<HTMLElement | null>(null);
	let draggingId = $state<string | null>(null);
	let dropAt = $state<{ id: string; edge: 'before' | 'after' } | null>(null);
	/** The notes below the gap in its column: they step down to open it (by transform). */
	let shifted = $state<ReadonlySet<string>>(new Set());
	type Drag = {
		id: string;
		item: HTMLElement;
		pointerId: number;
		touch: boolean;
		x0: number;
		y0: number;
		scroll0: number;
		x: number;
		y: number;
		boxes: Box[];
		place: Place | null;
		holdTimer?: ReturnType<typeof setTimeout>;
		frame?: number;
	};
	let drag: Drag | null = null;
	let swallowClick = false;
	const HOLD_MS = 350;
	const SLOP = 8;
	const EDGE = 64;

	function onPointerDown(event: PointerEvent) {
		if (drag || event.button !== 0 || !event.isPrimary) return;
		const target = event.target as HTMLElement;
		const item = target.closest<HTMLElement>('[data-note-id]');
		const note = item ? notes.find((n) => n.id === item.dataset.noteId) : undefined;
		if (!item || !note || !mayChange(note) || notes.length < 2) return;
		if (target.closest('button:not([data-drag-ok]), a, input, textarea, select, label')) return;
		const touch = event.pointerType !== 'mouse';
		drag = {
			id: note.id,
			item,
			pointerId: event.pointerId,
			touch,
			x0: event.clientX,
			y0: event.clientY,
			scroll0: window.scrollY,
			x: event.clientX,
			y: event.clientY,
			boxes: [],
			place: null,
		};
		if (touch) drag.holdTimer = setTimeout(startDrag, HOLD_MS);
		else event.preventDefault(); // no text selection while a mouse drags a note
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', cancelDrag);
	}

	function startDrag() {
		if (!drag || draggingId) return;
		const d = drag;
		clearTimeout(d.holdTimer);
		const sx = window.scrollX;
		const sy = window.scrollY;
		d.boxes = [...(boardEl?.querySelectorAll<HTMLElement>('[data-note-id]') ?? [])]
			.filter((el) => el.dataset.noteId !== d.id)
			.map((el) => {
				const r = el.getBoundingClientRect();
				return {
					id: el.dataset.noteId ?? '',
					left: r.left + sx,
					right: r.right + sx,
					top: r.top + sy,
					bottom: r.bottom + sy,
				};
			});
		try {
			d.item.setPointerCapture(d.pointerId);
		} catch {
			// The pointer is already gone; the next event ends the drag.
		}
		draggingId = d.id;
		window.addEventListener('touchmove', holdStill, { passive: false });
		window.addEventListener('keydown', onDragKey);
		window.addEventListener('contextmenu', holdStill);
		d.frame = requestAnimationFrame(frame);
	}

	/** Once a finger drags a note, it no longer scrolls the page or opens a menu. */
	function holdStill(event: Event) {
		event.preventDefault();
	}

	function onPointerMove(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		drag.x = event.clientX;
		drag.y = event.clientY;
		if (draggingId) return;
		const far = Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > SLOP;
		// A finger that moves before the hold scrolls the page; a mouse that moves starts the drag.
		if (far && drag.touch) endDrag();
		else if (far) startDrag();
	}

	/** One frame of a drag: scroll near the edges, move the paper, find the gap under it. */
	function frame() {
		const d = drag;
		if (!d || !draggingId) return;
		if (d.y < EDGE) window.scrollBy(0, -Math.ceil((EDGE - d.y) / 4));
		else if (d.y > window.innerHeight - EDGE)
			window.scrollBy(0, Math.ceil((d.y - window.innerHeight + EDGE) / 4));
		const dy = d.y - d.y0 + window.scrollY - d.scroll0;
		d.item.style.transform = `translate(${d.x - d.x0}px, ${dy}px) scale(1.02)`;
		const place = placeAt(notes, d.id, gapAt(d.boxes, d.x + window.scrollX, d.y + window.scrollY));
		const next =
			place === null
				? null
				: 'before' in place
					? { id: place.before, edge: 'before' as const }
					: { id: place.after, edge: 'after' as const };
		if (next?.id !== dropAt?.id || next?.edge !== dropAt?.edge) {
			dropAt = next;
			const at = next?.edge === 'before' ? d.boxes.find((b) => b.id === next.id) : undefined;
			shifted = new Set(
				at
					? d.boxes
							.filter((b) => Math.abs(b.left - at.left) < 4 && b.top >= at.top)
							.map((b) => b.id)
					: [],
			);
		}
		d.place = place;
		d.frame = requestAnimationFrame(frame);
	}

	function onPointerUp(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const { id, place } = drag;
		const moved = draggingId !== null;
		endDrag();
		if (!moved) return;
		// The click that ends a drag does not open the photo.
		swallowClick = true;
		setTimeout(() => (swallowClick = false), 0);
		if (place) void commitMove(id, place);
	}

	function onDragKey(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		cancelDrag();
	}

	function cancelDrag() {
		endDrag();
	}

	function endDrag() {
		const d = drag;
		drag = null;
		if (!d) return;
		clearTimeout(d.holdTimer);
		if (d.frame !== undefined) cancelAnimationFrame(d.frame);
		d.item.style.transform = '';
		draggingId = null;
		dropAt = null;
		shifted = new Set();
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', cancelDrag);
		window.removeEventListener('touchmove', holdStill);
		window.removeEventListener('keydown', onDragKey);
		window.removeEventListener('contextmenu', holdStill);
	}
	onDestroy(endDrag);

	function onClickCapture(event: MouseEvent) {
		if (!swallowClick) return;
		event.preventDefault();
		event.stopPropagation();
	}

	async function openPhoto(note: BoardNote) {
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		viewing = note;
		await tick();
		closeButton?.focus();
	}
	function closePhoto() {
		viewing = null;
		opener?.focus();
	}
	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && viewing) closePhoto();
	}

	function startWriting() {
		editingId = null;
		writing = true;
	}

	function done() {
		writing = false;
		editingId = null;
		void load();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet writeTile()}
	<!-- A pad of sticky notes: the top sheet is where the next note is written. -->
	<button
		type="button"
		class="pad day text-note-ink focus-visible:ring-ring w-full text-left focus-visible:ring-2 focus-visible:outline-none"
		onclick={startWriting}
		data-testid="write-note"
	>
		<span class="sheet under-2" aria-hidden="true"></span>
		<span class="sheet under-1" aria-hidden="true"></span>
		<span class="sheet top bg-note-1 grid min-h-32 content-end gap-2 p-4">
			<PenLine class="size-5 shrink-0 opacity-80" aria-hidden="true" />
			<span class="prompt">{t('write_tile')}</span>
			<span class="pen-line" aria-hidden="true"></span>
		</span>
	</button>
{/snippet}

{#snippet viewOnly()}
	<ViewOnly />
{/snippet}

{#snippet cork()}
	<div class="cork"><Garland /></div>
{/snippet}

<!-- The whole page is the board: cork from edge to edge (the frame's backdrop), a garland across
     the top. -->
<Page template="board" backdrop={cork}>
	<div class="board text-ink">
		{#if !canView}
			<PageHeader title={t('title')} />
			<div class="mx-auto max-w-[420px]">
				<EmptyState title={t('no_access')} />
			</div>
		{:else}
			<PageHeader title={t('title')} actions={canPost ? undefined : viewOnly} />
			<section bind:this={boardEl} aria-label={t('board_label')} data-testid="board">
				{#if loadError}
					<p class="text-ink mb-4 font-semibold" role="alert">{t('error')}</p>
				{/if}
				{#if loaded && !loadError && notes.length === 0 && !writing}
					<div class="notes">
						{#if canPost}
							<div class="item">{@render writeTile()}</div>
						{/if}
						<!-- An empty board still has one note on it: what the board is for. -->
						<div class="item" data-testid="board-empty">
							<div class="empty-note day bg-note-2 text-note-ink grid gap-1.5 p-4">
								<span class="empty-pin" aria-hidden="true"></span>
								<p class="empty-title">{t('empty_read_only')}</p>
								{#if canPost}<p class="text-note-ink-soft text-sm font-semibold">
										{t('empty_hint')}
									</p>{/if}
							</div>
						</div>
					</div>
				{:else}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="notes"
						class:dragging={draggingId !== null}
						onpointerdown={onPointerDown}
						onclickcapture={onClickCapture}
					>
						{#if canPost}
							<div class="item" class:writing>
								{#if writing}
									<Composer ondone={done} oncancel={() => (writing = false)} />
								{:else}
									{@render writeTile()}
								{/if}
							</div>
						{/if}
						{#each notes as note, i (note.id)}
							{@const movable = mayChange(note)}
							<div
								class="item"
								class:movable={movable && notes.length > 1}
								class:lifted={draggingId === note.id}
								class:writing={editingId === note.id}
								class:shift={shifted.has(note.id)}
								data-note-id={note.id}
							>
								{#if dropAt?.id === note.id}
									<span class="drop {dropAt.edge}" aria-hidden="true" data-testid="drop-gap"></span>
								{/if}
								{#if editingId === note.id}
									<Composer {note} ondone={done} oncancel={() => (editingId = null)} />
								{:else}
									<NoteCard
										{note}
										{now}
										canEdit={mayChange(note)}
										canPin={canManage}
										canEarlier={notes[i - 1]?.pinned === note.pinned}
										canLater={notes[i + 1]?.pinned === note.pinned}
										onmove={step}
										onphoto={openPhoto}
										onedit={(n) => {
											writing = false;
											editingId = n.id;
										}}
										onpin={pin}
										onremove={remove}
									/>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				<p class="sr-only" aria-live="polite">{announcement}</p>
			</section>
		{/if}
	</div>
</Page>

{#if viewing}
	<!-- Over a photo the text color is the day one whatever the theme (like member initials). -->
	<div
		class="day bg-backdrop/90 fixed inset-0 z-50 grid place-items-center p-4"
		role="dialog"
		aria-modal="true"
		aria-label={t('view_photo')}
	>
		<button
			type="button"
			class="absolute inset-0 cursor-default"
			aria-label={t('close')}
			tabindex="-1"
			onclick={closePhoto}
		></button>
		<img
			src={notePhotoUrl(viewing.id, viewing.updatedAt)}
			alt={t('photo_alt')}
			class="relative max-h-full max-w-full rounded-lg object-contain"
		/>
		<button
			bind:this={closeButton}
			type="button"
			class="text-on-color bg-scrim focus-visible:ring-ring absolute top-3 right-3 grid size-12 place-items-center rounded-full focus-visible:ring-2"
			aria-label={t('close')}
			onclick={closePhoto}
		>
			<X class="size-6" aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	/* The page's content; the garland hangs above it. */
	.board {
		container: cork / inline-size;
		/* The cork's own colour, kept for the papers: they take the day palette (`.day`), and by
		   night they are dimmed a little toward the lamp-lit cork. */
		--lamp: var(--board);
		padding-top: 2.25rem;
	}
	/*
	 * The cork: the frame's backdrop, the whole content area edge to edge (the board template
	 * bleeds into the shell's gutters), at least as tall as the window and as tall as its notes.
	 * Gradients only: daylight from the top left (a lamp's glow by night), soft blotches, fine
	 * speckles, and a shadow toward the edges.
	 */
	.cork {
		position: relative;
		background-color: var(--board);
		background-image:
			linear-gradient(
				135deg,
				color-mix(in srgb, var(--surface) 40%, transparent) 0,
				transparent 50%
			),
			radial-gradient(
				ellipse 34% 30% at 22% 28%,
				color-mix(in srgb, var(--board-grain) 55%, transparent),
				transparent 70%
			),
			radial-gradient(
				ellipse 30% 36% at 76% 72%,
				color-mix(in srgb, var(--board-grain) 45%, transparent),
				transparent 70%
			),
			radial-gradient(circle at 20% 30%, var(--board-grain) 0 1px, transparent 1.6px),
			radial-gradient(circle at 70% 60%, var(--board-grain) 0 1.3px, transparent 2.1px),
			radial-gradient(circle at 42% 88%, var(--board-grain) 0 0.9px, transparent 1.5px),
			radial-gradient(circle at 88% 12%, var(--board-grain) 0 1.1px, transparent 1.8px);
		background-size:
			100% 100%,
			620px 540px,
			540px 620px,
			23px 29px,
			37px 31px,
			17px 19px,
			41px 43px;
		background-repeat: no-repeat, repeat, repeat, repeat, repeat, repeat, repeat;
		box-shadow: inset 0 0 110px color-mix(in srgb, var(--backdrop) 13%, transparent);
	}
	/* By night the same cork, under a warm lamp near the top. */
	:global(.dark) .cork {
		background-image:
			radial-gradient(
				ellipse 60% 440px at 50% 0,
				color-mix(in srgb, var(--sun) 22%, transparent),
				transparent 75%
			),
			radial-gradient(
				ellipse 34% 30% at 22% 28%,
				color-mix(in srgb, var(--board-grain) 55%, transparent),
				transparent 70%
			),
			radial-gradient(
				ellipse 30% 36% at 76% 72%,
				color-mix(in srgb, var(--board-grain) 45%, transparent),
				transparent 70%
			),
			radial-gradient(circle at 20% 30%, var(--board-grain) 0 1px, transparent 1.6px),
			radial-gradient(circle at 70% 60%, var(--board-grain) 0 1.3px, transparent 2.1px),
			radial-gradient(circle at 42% 88%, var(--board-grain) 0 0.9px, transparent 1.5px),
			radial-gradient(circle at 88% 12%, var(--board-grain) 0 1.1px, transparent 1.8px);
		box-shadow: inset 0 0 120px color-mix(in srgb, var(--backdrop) 35%, transparent);
	}
	/* Masonry columns: two on a phone, up to five on a wide screen (by the board's own width). */
	.notes {
		columns: 2;
		column-gap: 0.75rem;
	}
	@container cork (width >= 560px) {
		.notes {
			columns: 3;
			column-gap: 1.25rem;
		}
	}
	@container cork (width >= 820px) {
		.notes {
			columns: 4;
		}
	}
	@container cork (width >= 1080px) {
		.notes {
			columns: 5;
			column-gap: 1.5rem;
		}
	}
	.item {
		position: relative;
		break-inside: avoid;
		margin-bottom: 0.5rem;
		/* Room for the pin or tape above the paper: in a column break a box that sticks out above
		   the first item would be drawn as a stray line in the column before. */
		padding-top: 1rem;
	}
	@container cork (width >= 560px) {
		.item {
			margin-bottom: 0.875rem;
		}
	}
	/* On a phone the paper being written takes the whole width (a column is too narrow for it). */
	@container cork (width < 560px) {
		.item.writing {
			column-span: all;
		}
	}
	.movable {
		cursor: grab;
		-webkit-touch-callout: none;
	}
	@media (pointer: coarse) {
		.movable {
			user-select: none;
		}
	}
	/* While a note is dragged, the notes below the gap step down to open it. */
	.dragging .item {
		transition: transform 120ms ease-out;
	}
	.item.shift {
		transform: translateY(1.5rem);
	}
	@media (prefers-reduced-motion: reduce) {
		.dragging .item {
			transition: none;
		}
	}
	/* The lifted note: above the others, a deeper shadow; it moves by transform only. */
	.dragging .item.lifted,
	.lifted {
		transition: none;
		z-index: 20;
		cursor: grabbing;
		will-change: transform;
	}
	.lifted :global(.paper) {
		transform: rotate(0deg);
		box-shadow:
			var(--shadow-pop),
			0 22px 30px -12px color-mix(in srgb, var(--backdrop) 45%, transparent);
	}
	/* Where the note will land: an empty slot in the gap above (or below) a note. */
	.drop {
		position: absolute;
		left: 0;
		right: 0;
		height: 0.55rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--ink) 22%, transparent);
		outline: 2px dashed color-mix(in srgb, var(--ink) 55%, transparent);
		outline-offset: -1px;
		pointer-events: none;
	}
	.drop.before {
		top: 0.2rem;
	}
	.drop.after {
		bottom: -0.55rem;
	}
	/* The pad: three sticky sheets, the two below peeking out askew. */
	.pad {
		position: relative;
		display: block;
		margin-bottom: 0.4rem;
		border-radius: var(--radius-sm);
	}
	.sheet {
		border-radius: var(--radius-sm);
	}
	.under-1,
	.under-2 {
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--note-1) 88%, var(--note-ink));
		box-shadow: var(--shadow-lit);
	}
	.under-2 {
		transform: translate(5px, 6px) rotate(2.5deg);
	}
	.under-1 {
		transform: translate(2px, 3px) rotate(1.2deg);
		background: color-mix(in srgb, var(--note-1) 94%, var(--note-ink));
	}
	.top {
		position: relative;
		transform: rotate(-0.8deg);
		box-shadow:
			var(--shadow-lit),
			0 8px 14px -8px color-mix(in srgb, var(--backdrop) 35%, transparent);
		transition: transform 150ms ease-out;
	}
	/* By night the pale sheets glow a little less, in the lamp's light. */
	:global(.dark) .top {
		background-color: color-mix(in srgb, var(--note-1) 84%, var(--lamp));
	}
	:global(.dark) .under-1 {
		background: color-mix(
			in srgb,
			color-mix(in srgb, var(--note-1) 94%, var(--note-ink)) 84%,
			var(--lamp)
		);
	}
	:global(.dark) .under-2 {
		background: color-mix(
			in srgb,
			color-mix(in srgb, var(--note-1) 88%, var(--note-ink)) 84%,
			var(--lamp)
		);
	}
	:global(.dark) .empty-note {
		background-color: color-mix(in srgb, var(--note-2) 84%, var(--lamp));
	}
	.pad,
	.empty-note {
		color-scheme: light;
	}
	:global(.dark) .empty-note :global(.text-note-ink-soft) {
		color: color-mix(in srgb, var(--note-ink-soft) 60%, var(--note-ink));
	}
	.pad:hover .top,
	.pad:focus-visible .top {
		transform: rotate(0deg) translateY(-2px);
	}
	@media (prefers-reduced-motion: reduce) {
		.top {
			transition: none;
		}
	}
	@media (prefers-contrast: more) {
		.under-1,
		.under-2,
		.top,
		.pad:hover .top {
			transform: none;
		}
	}
	/* "Write a note…": the style's serif (italic where it is a real serif), large. */
	.prompt {
		font-family: var(--font-serif);
		font-style: var(--ramp-dateline-style, normal);
		font-weight: var(--ramp-dateline-weight, 700);
		font-size: 1.45rem;
		line-height: 1.15;
	}
	.pen-line {
		display: block;
		height: 2px;
		border-radius: 2px;
		background: color-mix(in srgb, var(--note-ink-soft) 45%, transparent);
	}
	/* The one note on an empty board. */
	.empty-note {
		position: relative;
		border-radius: var(--radius-sm);
		transform: rotate(1.4deg);
		box-shadow:
			var(--shadow-lit),
			0 10px 16px -9px color-mix(in srgb, var(--backdrop) 38%, transparent);
	}
	@media (prefers-contrast: more) {
		.empty-note {
			transform: none;
		}
	}
	.empty-title {
		font-family: var(--font-serif);
		font-weight: var(--ramp-dateline-weight, 700);
		font-size: 1.35rem;
		line-height: 1.2;
	}
	.empty-pin {
		position: absolute;
		top: -0.45rem;
		left: 50%;
		width: 14px;
		height: 14px;
		margin-left: -7px;
		border-radius: 999px;
		background:
			radial-gradient(
				circle at 34% 30%,
				color-mix(in srgb, var(--surface) 85%, transparent) 0 1.6px,
				transparent 3.2px
			),
			radial-gradient(
				circle at 40% 35%,
				var(--info) 0 55%,
				color-mix(in srgb, var(--info) 72%, var(--backdrop)) 100%
			);
		box-shadow:
			0 0 0 0.5px color-mix(in srgb, var(--backdrop) 25%, transparent),
			2px 3px 2px -1px color-mix(in srgb, var(--backdrop) 40%, transparent);
	}
</style>
