<script lang="ts" module>
	/** The day-by-person words (catalog strings, already translated). */
	export interface MemberDayWords {
		/** In the time slot of an all-day item: "All day". */
		allDay: string;
		/** "+2 more". */
		more(count: number): string;
		/** A column with nothing: "Nothing planned." (serif). */
		nothing: string;
		/** A row with nothing still to come: "Nothing more today". */
		nothingMore: string;
		/** A row's follow-on: "then Football 17:00, Dinner 19:00". */
		followedBy(list: string): string;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { TimelineItem } from '../slots.js';
	import Avatar from './Avatar.svelte';
	import { formatClock, isTimed, type TodayFormat } from './today-v3.js';

	/**
	 * One person's day. `column` (Broadsheet's wall): a 3 px rule in their colour over
	 * their name and up to `max` cards, past cards receded, the next one outlined in `accent`,
	 * then "+n more"; with nothing, the serif "Nothing planned." and a meta line. `stack` (phones):
	 * the same with the rule at the side and two cards. `row` (Wall's "Who, next"): a ringed avatar,
	 * the name and a meta line (after the person's note), the next thing large with what follows, and
	 * `trailing` (a ring).
	 * Member colour only as the rule and the avatar, never as a surface or text.
	 */
	let {
		member,
		items,
		now,
		format,
		words,
		variant = 'column',
		max,
		nextId = null,
		meta,
		note,
		showName = true,
		flow = false,
		trailing,
	}: {
		/**
		 * `anyone`: the things for no one in particular (a people icon, not a letter). `shortName`
		 * (`withShortNames`) is what the heading shows; the full name stays its title and label.
		 */
		member: { displayName: string; shortName?: string; color: string; anyone?: boolean };
		/** Their all-day and timed items in the day's order (`memberDays`). */
		items: readonly TimelineItem[];
		now: number;
		format: TodayFormat;
		words: MemberDayWords;
		variant?: 'column' | 'stack' | 'row';
		/** Cards before "+n more": 3 in a column, 2 in a stack. */
		max?: number;
		/** The hero's item, outlined. */
		nextId?: string | null;
		/** Under "Nothing planned." in a column, under the name in a row: "1 chore left". */
		meta?: string;
		/**
		 * A row: a word about the person ("Home", from an extension), before the meta line, or under
		 * the avatar when the name is left out. Never coloured.
		 */
		note?: string;
		/** Rows on a phone drop the name (the avatar carries it); it stays for screen readers. */
		showName?: boolean;
		/** A column: the cards flow side by side (one column for everyone, on a display). */
		flow?: boolean;
		trailing?: Snippet;
	} = $props();

	const heading = $derived(member.shortName ?? member.displayName);
	const limit = $derived(max ?? (variant === 'stack' ? 2 : 3));
	const shown = $derived(items.slice(0, limit));
	const hidden = $derived(Math.max(0, items.length - limit));
	const ended = (item: TimelineItem) => isTimed(item) && (item.end ?? item.start ?? 0) <= now;
	const timeOf = (item: TimelineItem) =>
		isTimed(item) ? formatClock(item.start as number, format) : words.allDay;
	const detail = (item: TimelineItem) => item.location ?? '';

	// A row: the next timed thing still to come, then the rest of the day's timed items.
	const ahead = $derived(items.filter((item) => isTimed(item) && !ended(item)));
	const first = $derived(ahead[0]);
	const later = $derived(
		ahead
			.slice(1)
			.map((item) => `${item.title} ${formatClock(item.start as number, format)}`)
			.join(', '),
	);
	const allDay = $derived(items.find((item) => !isTimed(item)));
</script>

{#snippet card(item: TimelineItem)}
	<li class="card" class:past={ended(item)} class:next={item.id === nextId}>
		<time class="font-display">{timeOf(item)}</time>
		<span class="what">
			<b>{item.title}</b>
			{#if detail(item)}<small>{detail(item)}</small>{/if}
		</span>
	</li>
{/snippet}

{#if variant === 'row'}
	<div class="row" style:--member={member.color} data-testid="member-day">
		<span class="who">
			<span class="ringed"
				><Avatar
					name={member.displayName}
					color={member.color}
					size={40}
					anyone={member.anyone}
				/></span
			>
			{#if note && !showName}<small class="note" title={note}>{note}</small>{/if}
		</span>
		<span class="name" class:sr-only={!showName}>
			<b title={member.displayName}
				>{#if heading === member.displayName}{heading}{:else}<span aria-hidden="true"
						>{heading}</span
					><span class="sr-only">{member.displayName}</span>{/if}</b
			>
			{#if note || meta}<small>{[note, meta].filter(Boolean).join(' · ')}</small>{/if}
		</span>
		{#if first}
			<span class="nx">
				<time>{formatClock(first.start as number, format)}</time>
				<span class="t">
					<b>{first.title}</b>
					{#if detail(first) || later}
						<small
							>{[detail(first), later ? words.followedBy(later) : '']
								.filter(Boolean)
								.join(' · ')}</small
						>
					{/if}
				</span>
			</span>
		{:else}
			<span class="nx free"
				>{allDay?.title ?? (items.length === 0 ? words.nothing : words.nothingMore)}</span
			>
		{/if}
		{#if trailing}<span class="trail">{@render trailing()}</span>{/if}
	</div>
{:else}
	<section
		class="mday {variant}"
		class:none={items.length === 0}
		style:--member={member.color}
		aria-label={member.displayName}
		data-testid="member-day"
	>
		<div class="mh">
			<Avatar name={member.displayName} color={member.color} size={24} anyone={member.anyone} />
			<b title={member.displayName}>{heading}</b>
		</div>
		{#if items.length > 0}
			<ul class="cards" class:flow>
				{#each shown as item (item.id)}{@render card(item)}{/each}
			</ul>
			{#if hidden > 0}<span class="more">{words.more(hidden)}</span>{/if}
		{:else}
			<span class="free font-serif">{words.nothing}</span>
			{#if meta}<span class="more">{meta}</span>{/if}
		{/if}
	</section>
{/if}

<style>
	/*
	 * Every grid here has one column that may shrink (`minmax(0, 1fr)`): a long title or place
	 * then ellipsizes inside its card instead of widening the card into the next person's column.
	 */
	.mday {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: 6px;
		min-width: 0;
		padding-top: 10px;
		border-top: 3px solid var(--member);
	}
	.stack {
		gap: 4px;
		padding: 2px 0 2px 12px;
		border-top: 0;
		border-inline-start: 3px solid var(--member);
	}
	.mh {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
		min-width: 0;
	}
	.stack .mh {
		margin-bottom: 0;
	}
	.mh b {
		overflow: hidden;
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
	}
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.cards.flow {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 9.5rem), 1fr));
		align-items: stretch;
	}
	.card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		/* A card stretched to its row's height (side by side) keeps its lines together at the top. */
		align-content: start;
		gap: 1px;
		min-width: 0;
		overflow: hidden;
		padding: 8px 10px;
		border-radius: 10px;
		background: var(--surface);
		box-shadow: var(--shadow-lit);
		font-size: 13px;
		line-height: 1.25;
	}
	.card time {
		font-size: 16px;
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.card .what {
		display: grid;
		min-width: 0;
	}
	/* The title wraps to two lines, then an ellipsis; the place keeps one line. */
	.card b {
		display: -webkit-box;
		overflow: hidden;
		overflow-wrap: break-word;
		font-weight: 600;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.card small,
	.row small {
		display: block;
		overflow: hidden;
		font-size: 11.5px;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card.past {
		opacity: 0.5;
		background: var(--idle);
		box-shadow: none;
	}
	.card.next {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.more {
		padding: 4px 2px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-soft);
	}
	.free {
		padding: 4px 2px;
		font-size: 16px;
		font-style: italic;
		line-height: 1.2;
		color: var(--ink-soft);
	}
	.row {
		display: grid;
		grid-template-columns: 56px 150px minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		min-height: 62px;
		padding: 6px 0;
	}
	.row:has(.name.sr-only) {
		grid-template-columns: minmax(44px, auto) minmax(0, 1fr) auto;
	}
	.who {
		display: grid;
		justify-items: center;
		gap: 6px;
		min-width: 0;
	}
	.who:has(.note) .ringed {
		justify-self: center;
		margin-inline-start: 0;
	}
	/* Under the avatar on a phone: short ("Home", "At School"), cut beyond that. */
	.who .note {
		max-width: 72px;
		overflow: hidden;
		font-size: 11px;
		font-weight: 600;
		line-height: 1.1;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ringed {
		display: inline-flex;
		border-radius: 999px;
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--member);
		justify-self: start;
		margin-inline-start: 4px;
	}
	.name {
		display: grid;
		min-width: 0;
		line-height: 1.2;
	}
	.name b {
		overflow: hidden;
		font-size: 16px;
		font-weight: 800;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nx {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.nx time {
		font-size: 26px;
		font-weight: 800;
		letter-spacing: -0.03em;
		line-height: 1;
		white-space: nowrap;
	}
	.nx .t {
		display: grid;
		min-width: 0;
		line-height: 1.2;
	}
	.nx .t b {
		overflow: hidden;
		font-size: 15px;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nx.free {
		display: block;
		font-style: normal;
		overflow: hidden;
		font-size: 15px;
		font-weight: 500;
		color: var(--ink-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.trail {
		display: inline-flex;
	}
</style>
