<script lang="ts">
	import { Avatar, Menu, type MenuItem } from '@famos/ui/famos';
	import { Clock, Ellipsis } from '@lucide/svelte';
	import { onDestroy, tick } from 'svelte';
	import type { BoardNote } from '../contract/index.js';
	import { useBoard } from './i18n.js';
	import { notePhotoUrl } from './data.js';
	import {
		fastenerOf,
		isShortNote,
		PAPER_CLASS,
		postedLabel,
		tiltOf,
		untilLabel,
	} from './paper.js';

	/**
	 * One paper on the board. `board`: the page (menu, photo opens large); `card`: a small paper on
	 * Today (the whole paper is a link, written by the parent); `display`: a wall screen, larger
	 * type, nothing to touch.
	 */
	let {
		note,
		now,
		variant = 'board',
		canEdit = false,
		canPin = false,
		canEarlier = false,
		canLater = false,
		onphoto,
		onedit,
		onpin,
		onmove,
		onremove,
	}: {
		note: BoardNote;
		now: number;
		variant?: 'board' | 'card' | 'display';
		/** The author, or someone who manages the board. */
		canEdit?: boolean;
		canPin?: boolean;
		/** A note of the same group comes before (after) it: the menu offers a step that way. */
		canEarlier?: boolean;
		canLater?: boolean;
		onphoto?: (note: BoardNote) => void;
		onedit?: (note: BoardNote) => void;
		onpin?: (note: BoardNote) => void;
		/** Move earlier (-1) or later (1); the way for keyboards and screen readers. */
		onmove?: (note: BoardNote, step: -1 | 1) => void;
		onremove?: (note: BoardNote) => void | Promise<void>;
	} = $props();
	const { app, t } = useBoard();

	const author = $derived(
		note.createdBy ? app.members().find((m) => m.id === note.createdBy) : undefined,
	);
	/** Everyone who saw it except the person who wrote it. */
	const seen = $derived(
		note.seenBy
			.filter((id) => id !== note.createdBy)
			.map((id) => app.members().find((m) => m.id === id))
			.filter((m) => m !== undefined),
	);
	const seenCount = $derived(note.seenBy.filter((id) => id !== note.createdBy).length);
	/** "Seen by Ayşe and Ece" while there are three or fewer (and all are known), else a count. */
	const seenText = $derived.by(() => {
		const [a, b, c] = seen.map((m) => m.displayName);
		if (seen.length === seenCount && a !== undefined && seenCount <= 3) {
			if (c !== undefined && b !== undefined) return t('seen_by_names_3', { a, b, c });
			if (b !== undefined) return t('seen_by_names_2', { a, b });
			return t('seen_by_names_1', { a });
		}
		return t('seen_by', { count: seenCount });
	});
	const showMenu = $derived(variant === 'board' && (canEdit || canPin));
	/** A push pin or tape, fixed per note; a pinned note always gets the accent pin. */
	const fastener = $derived(fastenerOf(note));
	// On the board a few words are written large, and a photo note is a polaroid.
	const short = $derived(variant === 'board' && isShortNote(note));
	const polaroid = $derived(variant === 'board' && note.hasPhoto);
	// Seen faces belong to the board itself; the small papers on Today leave them out.
	const showSeen = $derived(variant !== 'card' && seenCount > 0);
	let textEl = $state<HTMLElement | null>(null);
	let expanded = $state(false);
	let overflows = $state(false);
	// A long note is cut after about twelve lines on the board, with a More toggle.
	$effect(() => {
		void note.text;
		if (variant !== 'board' || expanded || !textEl) return;
		const el = textEl;
		void tick().then(() => (overflows = el.scrollHeight > el.clientHeight + 1));
	});
	/** How long "take down" stays armed for a second pick. */
	const ARM_MS = 8000;
	let menuOpen = $state(false);
	let armed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(timer));

	/**
	 * The menu's "Take down" arms it; a button over the note then does it. The menu closes on any
	 * pick, so the second tap lives on the note itself, laid over it so the board never moves.
	 */
	function arm() {
		armed = true;
		clearTimeout(timer);
		timer = setTimeout(() => (armed = false), ARM_MS);
	}
	function remove() {
		armed = false;
		clearTimeout(timer);
		void onremove?.(note);
	}

	const items = $derived.by(() => {
		const list: MenuItem[] = [];
		if (canEdit) list.push({ id: 'edit', label: t('edit'), onselect: () => onedit?.(note) });
		if (canPin)
			list.push({
				id: 'pin',
				label: note.pinned ? t('unpin') : t('pin'),
				onselect: () => onpin?.(note),
			});
		if (canEdit && canEarlier)
			list.push({ id: 'earlier', label: t('move_earlier'), onselect: () => onmove?.(note, -1) });
		if (canEdit && canLater)
			list.push({ id: 'later', label: t('move_later'), onselect: () => onmove?.(note, 1) });
		if (canEdit)
			list.push({
				id: 'remove',
				label: t('remove'),
				danger: true,
				onselect: arm,
			});
		return list;
	});
</script>

<article
	class="paper {polaroid
		? 'polaroid'
		: PAPER_CLASS[note.paper]} text-note-ink relative grid gap-2 p-3 {variant}"
	class:day={variant === 'board'}
	class:menu-open={menuOpen}
	style:--tilt="{tiltOf(note.id)}deg"
	style:--paper="var(--{note.paper})"
	data-testid="note"
	data-paper={note.paper}
>
	{#if fastener.kind === 'tape'}
		<span class="tape bg-note-tape" aria-hidden="true"></span>
	{:else}
		<span
			class="pin"
			class:pinned={note.pinned}
			style:--pin="var(--{fastener.color})"
			aria-hidden="true"
		></span>
	{/if}
	{#if note.pinned}
		<span class="sr-only">{t('pinned')}</span>
	{/if}
	{#if note.hasPhoto}
		{#if variant === 'board' && onphoto}
			<button
				type="button"
				onclick={() => onphoto?.(note)}
				data-drag-ok
				class="focus-visible:ring-ring block overflow-hidden rounded-sm focus-visible:ring-2"
				aria-label={t('view_photo')}
			>
				<img
					src={notePhotoUrl(note.id, note.updatedAt)}
					alt={t('photo_alt')}
					loading="lazy"
					class="photo w-full object-cover"
				/>
			</button>
		{:else}
			<img
				src={notePhotoUrl(note.id, note.updatedAt)}
				alt={t('photo_alt')}
				loading="lazy"
				class="photo w-full rounded-sm object-cover"
			/>
		{/if}
	{/if}
	<div class="relative">
		{#if showMenu}
			<!-- In the paper's top corner; on a polaroid in the caption row, never over the photo. The
			     actions open over the board, so the card never changes height. -->
			<div class="menu absolute z-10" class:on-frame={polaroid}>
				<Menu bind:open={menuOpen} {items} label={t('note_menu')}>
					{#snippet trigger({ attrs })}
						<button
							type="button"
							class="text-note-ink hover:bg-note-ink/10 focus-visible:ring-ring grid size-11 place-items-center rounded-lg focus-visible:ring-2"
							aria-label={t('note_menu')}
							data-menu
							{...attrs}
						>
							<Ellipsis class="size-5" aria-hidden="true" />
						</button>
					{/snippet}
				</Menu>
			</div>
			{#if armed}
				<button
					type="button"
					class="confirm bg-destructive text-destructive-foreground focus-visible:ring-ring absolute z-20 rounded-lg px-3 py-2 text-sm font-medium focus-visible:ring-2"
					onclick={remove}>{t('remove_confirm')}</button
				>
			{/if}
		{/if}
		<p
			bind:this={textEl}
			class="text [overflow-wrap:anywhere] whitespace-pre-line"
			class:clamped={variant === 'board' && !expanded}
			class:short
			class:caption={polaroid}
		>
			{#if showMenu}<span class="spacer" aria-hidden="true"></span>{/if}{note.text}
		</p>
		{#if variant === 'board' && (overflows || expanded)}
			<button
				type="button"
				class="text-note-ink mt-1 min-h-8 text-sm font-bold underline"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}>{expanded ? t('less') : t('more')}</button
			>
		{/if}
	</div>

	<footer class="meta text-note-ink-soft flex flex-wrap items-center gap-x-1.5 gap-y-1">
		{#if author}
			<Avatar
				name={author.displayName}
				color={author.color}
				size={variant === 'display' ? 26 : 18}
			/>
			<span class="sr-only">{t('by_author', { name: author.displayName })}</span>
		{/if}
		<span>{postedLabel(note.createdAt, now, t, app.timeZone(), app.formatLocale())}</span>
		{#if note.endsOn}
			<span class="until bg-note-ink/10 text-note-ink flex items-center gap-1 font-bold">
				<Clock class="size-3" aria-hidden="true" />
				{untilLabel(note.endsOn, now, t, app.timeZone(), app.formatLocale())}
			</span>
		{/if}
		{#if showSeen}
			<span class="ml-auto text-right font-semibold" data-testid="note-seen">{seenText}</span>
		{/if}
	</footer>
</article>

<style>
	/* Paper on cork: a contact shadow and a soft drop, a slight fixed tilt, and a corner that
	   lifts a little off the board. */
	.paper {
		border-radius: var(--radius-sm);
		box-shadow:
			var(--shadow-lit),
			0 1px 1px color-mix(in srgb, var(--backdrop) 10%, transparent),
			0 10px 16px -9px color-mix(in srgb, var(--backdrop) 38%, transparent);
		transform: rotate(var(--tilt));
		transition:
			transform 150ms ease-out,
			box-shadow 150ms ease-out;
	}
	/* On the board, paper stays paper at night: the day sheets (`.day` pins the day palette, ink
	   included), dimmed a little toward the lamp-lit cork (`--lamp`, the board's night colour). */
	.board {
		color-scheme: light;
	}
	:global(.dark) .board {
		background-color: color-mix(in srgb, var(--paper) 84%, var(--lamp, var(--board)));
	}
	:global(.dark) .board.polaroid {
		background-color: color-mix(
			in srgb,
			color-mix(in srgb, var(--surface) 82%, var(--paper)) 84%,
			var(--lamp, var(--board))
		);
	}
	/* The softer ink leans toward the ink by night, so it keeps 4.5:1 on the dimmed paper. */
	:global(.dark) .board :global(.text-note-ink-soft) {
		color: color-mix(in srgb, var(--note-ink-soft) 60%, var(--note-ink));
	}
	/* The menu sits in the paper's top corner, or in a polaroid's caption row. */
	.confirm {
		top: 0;
		right: 2.75rem;
	}
	.menu {
		top: -0.75rem;
		right: -0.75rem;
	}
	.menu.on-frame {
		top: -0.4rem;
		right: -0.55rem;
	}
	/* The open menu lies over the notes after this one (a tilted paper makes its own layer). */
	.paper.menu-open {
		z-index: 20;
	}
	.paper::after {
		content: '';
		position: absolute;
		right: 0;
		bottom: 0;
		width: 1.75rem;
		height: 1.75rem;
		border-bottom-right-radius: var(--radius-sm);
		background: linear-gradient(
			315deg,
			color-mix(in srgb, var(--backdrop) 9%, transparent) 0,
			color-mix(in srgb, var(--surface) 22%, transparent) 30%,
			transparent 60%
		);
		pointer-events: none;
	}
	/* Looked at, a paper straightens and lifts a little. */
	.board:hover,
	.board:focus-within {
		transform: rotate(0deg) translateY(-2px);
		box-shadow:
			var(--shadow-lit),
			0 2px 3px color-mix(in srgb, var(--backdrop) 10%, transparent),
			0 16px 22px -10px color-mix(in srgb, var(--backdrop) 42%, transparent);
	}
	@media (prefers-reduced-motion: reduce) {
		.paper {
			transition: none;
		}
	}
	/* A person who asks for more contrast gets straight, plain papers. */
	@media (prefers-contrast: more) {
		.paper,
		.board:hover,
		.board:focus-within {
			transform: none;
		}
	}
	.tape {
		position: absolute;
		/* High enough that it never covers the first line of text. */
		top: -0.85rem;
		left: 50%;
		width: 4.25rem;
		height: 1.2rem;
		/* Leans against the paper's own tilt, as tape stuck on in a hurry does. */
		transform: translateX(-50%) rotate(calc(var(--tilt) * -1.5 - 1deg));
		box-shadow: 0 1px 1px color-mix(in srgb, var(--backdrop) 14%, transparent);
	}
	/* A push pin: a round head with a highlight, and its shadow on the paper. */
	.pin {
		position: absolute;
		top: -0.45rem;
		left: 50%;
		z-index: 1;
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
				var(--pin) 0 55%,
				color-mix(in srgb, var(--pin) 72%, var(--backdrop)) 100%
			);
		box-shadow:
			0 0 0 0.5px color-mix(in srgb, var(--backdrop) 25%, transparent),
			2px 3px 2px -1px color-mix(in srgb, var(--backdrop) 40%, transparent);
	}
	/* A note pinned to the top: a bigger pin in the accent, ringed, easy to tell from the rest. */
	.pin.pinned {
		top: -0.6rem;
		width: 19px;
		height: 19px;
		margin-left: -9.5px;
		box-shadow:
			0 0 0 2px color-mix(in srgb, var(--surface) 70%, transparent),
			0 0 0 2.5px color-mix(in srgb, var(--backdrop) 22%, transparent),
			2px 4px 3px -1px color-mix(in srgb, var(--backdrop) 45%, transparent);
	}
	.text {
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.35;
	}
	/* A few words, written large: the style's serif where it has one, else the body face bold. */
	.text.short {
		font-family: var(--font-serif);
		font-size: 1.35rem;
		font-weight: var(--ramp-dateline-weight, 700);
		line-height: 1.2;
	}
	/* A photo note is a polaroid: a light frame, a thicker margin below with the words in it. */
	.polaroid {
		background-color: color-mix(in srgb, var(--surface) 82%, var(--paper));
		padding: 0.55rem 0.55rem 0.9rem;
	}
	.text.caption {
		font-family: var(--font-serif);
		font-style: italic;
		font-weight: var(--ramp-dateline-weight, 600);
		font-size: 1.125rem;
		line-height: 1.25;
		padding-inline: 0.15rem;
	}
	.meta {
		font-size: 0.6875rem;
	}
	.polaroid .meta {
		padding-inline: 0.15rem;
	}
	/* "Until Fri": a tiny tag. */
	.until {
		border-radius: 4px;
		padding: 0.05rem 0.35rem;
	}
	.photo {
		max-height: 16rem;
	}
	/* Room in the first line for the menu button in the corner. */
	.spacer {
		float: right;
		width: 1.75rem;
		height: 1.5rem;
	}
	.clamped {
		max-height: calc(1.35em * 12);
		overflow: hidden;
	}
	.card .text {
		font-size: 0.875rem;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.card .photo {
		max-height: 5rem;
	}
	.display {
		padding: 0.9rem;
		gap: 0.6rem;
	}
	.display .text {
		font-size: 1.25rem;
		line-height: 1.3;
		display: -webkit-box;
		-webkit-line-clamp: 6;
		line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.display .photo {
		max-height: 9rem;
	}
	.display .meta {
		font-size: 0.8125rem;
	}
</style>
