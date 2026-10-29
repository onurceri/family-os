<script lang="ts" module>
	import type { CountdownWords, NextUpMode, PillWords } from './today-v3.js';

	/** The hero's words (catalog strings, already translated). */
	export interface NextUpWords {
		/** The caps label: "Next up". */
		nextUp: string;
		/** The toggle: its accessible name and its two segments. */
		toggle: string;
		family: string;
		me: string;
		countdown: CountdownWords;
		pill: PillWords;
	}
	export type { NextUpMode };
</script>

<script lang="ts">
	import type { TimelineItem } from '../slots.js';
	import Avatar from './Avatar.svelte';
	import Countdown from './Countdown.svelte';
	import Segmented from './Segmented.svelte';
	import {
		countdown,
		countdownName,
		formatClock,
		pillOf,
		pillText,
		type TodayFormat,
	} from './today-v3.js';

	/**
	 * The next thing, on the one accent surface of the page: a caps label
	 * `NEXT UP · <name>` with the person's avatar and the **Family | Me** toggle, the title on the
	 * card's whole width, then the time and place with the pill beside the countdown, the biggest
	 * number on the page (it never takes the title's room, so words stay whole). The
	 * toggle shows only for a person (`onmode`) and never in family mode (displays). Text is
	 * `on-accent`; the pill inverts the pair. The accessible name reads "Piano lesson, 15:45, in
	 * 25 minutes".
	 */
	let {
		item,
		now,
		format,
		words,
		member = null,
		mode = 'family',
		onmode,
		familyMode = false,
		variant = 'serif',
		countdownVariant = 'number',
		ringSize = 128,
	}: {
		item: TimelineItem;
		now: number;
		format: TodayFormat;
		words: NextUpWords;
		/** Whose it is (the item's first member); none for "anyone" or with names off. */
		member?: { displayName: string; color: string } | null;
		mode?: NextUpMode;
		/** Saves the person's choice (`core.setMyNextUp`); without it there is no toggle. */
		onmode?: (mode: NextUpMode) => void;
		/** A display: no person, so no toggle and no link. */
		familyMode?: boolean;
		/** `serif`: the title in the serif slot (Broadsheet); `plain`: bold body face (Wall). */
		variant?: 'serif' | 'plain';
		countdownVariant?: 'number' | 'ring';
		ringSize?: number;
	} = $props();

	const start = $derived(item.start ?? now);
	const count = $derived(countdown(now, start, item.end));
	const pill = $derived(pillText(pillOf(item, count), format, words.pill));
	const name = $derived(countdownName(item, now, format, words.countdown));
	const range = $derived(
		item.end !== undefined && item.end - start >= 60_000
			? `${formatClock(start, format)}–${formatClock(item.end, format)}`
			: formatClock(start, format),
	);
	const meta = $derived([range, item.location?.trim()].filter(Boolean).join(' · '));
	const showToggle = $derived(!familyMode && onmode !== undefined);
	const options = $derived([
		{ value: 'family', label: words.family },
		{ value: 'me', label: words.me },
	]);
</script>

<section class="hero {variant}" aria-label={name} data-testid="next-up">
	<div class="lab">
		{#if member}<Avatar name={member.displayName} color={member.color} size={24} />{/if}
		<span class="caps"
			>{words.nextUp}{#if member}{` · ${member.displayName}`}{/if}</span
		>
		{#if showToggle}
			<span class="toggle">
				<Segmented
					{options}
					value={mode}
					label={words.toggle}
					size="sm"
					onchange={(value) => onmode?.(value as NextUpMode)}
				/>
			</span>
		{/if}
	</div>
	<h2 class="title" class:font-serif={variant === 'serif'}>
		{#if !familyMode && item.href}<a href={item.href}>{item.title}</a>{:else}{item.title}{/if}
	</h2>
	<div class="meta">
		<span>{meta}</span>
		{#if pill}<span class="pill">{pill}</span>{/if}
	</div>
	<Countdown {count} {format} words={words.countdown} variant={countdownVariant} size={ringSize} />
</section>

<style>
	/*
	 * The title has the card's whole width; the countdown sits at the end of the time-and-place
	 * row. Wall's ring is a fixed size, so it stands beside the title and that row (its own area,
	 * never more than the ring's width).
	 */
	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'lab lab'
			'title title'
			'meta count';
		column-gap: 16px;
		align-items: end;
		min-width: 0;
		padding: 22px 26px;
		border-radius: 22px;
		background: var(--accent);
		color: var(--on-accent);
		container-type: inline-size;
	}
	.plain {
		grid-template-areas:
			'lab lab'
			'title count'
			'meta count';
		border-radius: 24px;
	}
	.hero > :global(.countdown) {
		grid-area: count;
	}
	.plain > :global(.countdown) {
		align-self: center;
	}
	.lab {
		grid-area: lab;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.lab :global(.day) {
		box-shadow: 0 0 0 2px var(--accent);
	}
	.caps {
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.toggle {
		margin-inline-start: auto;
	}
	/* A narrow hero: the toggle gets a line of its own, at the start, not floating mid-card. */
	@container (max-width: 36rem) {
		.toggle {
			flex-basis: 100%;
			margin-inline-start: 0;
		}
	}
	.title {
		grid-area: title;
		margin: 12px 0 10px;
		/* The style's size, smaller in a narrow card so that a long word still fits its line. */
		font-size: min(var(--ramp-hero, 3.375rem), 11cqi);
		line-height: 0.98;
		letter-spacing: -0.01em;
		/* Words stay whole: only a single word longer than the whole line breaks. */
		overflow-wrap: break-word;
		hyphens: manual;
	}
	.serif .title {
		font-weight: 400;
	}
	.plain .title {
		font-weight: 800;
		letter-spacing: -0.03em;
		line-height: 1;
	}
	.title a {
		color: inherit;
		text-decoration: none;
	}
	.title a:hover {
		text-decoration: underline;
	}
	.title a:focus-visible {
		outline: 2px solid var(--on-accent);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.meta {
		grid-area: meta;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		font-size: 15px;
		font-weight: 600;
	}
	.meta > span:first-child {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	/* A long place ends in "…" inside the card; the line above already shows it whole. */
	.pill {
		display: inline-block;
		max-width: 100%;
		height: 28px;
		line-height: 28px;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 0 12px;
		border-radius: 999px;
		background: var(--on-accent);
		color: var(--accent);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		white-space: nowrap;
	}
</style>
