<script lang="ts" module>
	/** One line under "Then": what follows the next thing. */
	export interface ThenLine {
		id: string;
		time: string;
		title: string;
		/** The member's colour, or empty for anyone. */
		color: string;
		href: string;
	}
</script>

<script lang="ts">
	import {
		Avatar,
		Countdown,
		countdown,
		countdownName,
		formatClock,
		type NextUpMode,
		type NextUpWords,
		pillOf,
		pillText,
		Segmented,
		type TodayFormat,
	} from '@famos/ui/famos';
	import type { TimelineItem } from '@famos/ui/slots';

	/**
	 * Lanes' next thing as a departure board: the
	 * countdown on the page's one `accent` surface at the start, the title, the time and place
	 * with the pill, the **Family | Me** toggle on the label line, and "Then" with what follows.
	 * On a phone (`compact`) the board loses "Then". The accessible name reads "Piano lesson,
	 * 15:45, in 25 minutes", as the other styles' hero does.
	 */
	let {
		item,
		now,
		format,
		words,
		member = null,
		mode = 'family',
		onmode,
		then,
		thenTitle,
		thenNone,
		compact = false,
	}: {
		item: TimelineItem;
		now: number;
		format: TodayFormat;
		words: NextUpWords;
		member?: { displayName: string; color: string } | null;
		mode?: NextUpMode;
		onmode?: (mode: NextUpMode) => void;
		then: readonly ThenLine[];
		thenTitle: string;
		thenNone: string;
		compact?: boolean;
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
	const options = $derived([
		{ value: 'family', label: words.family },
		{ value: 'me', label: words.me },
	]);
</script>

<div class="wrap">
	<section class="board" class:compact aria-label={name} data-testid="next-up">
		<div class="cnt">
			<Countdown {count} {format} words={words.countdown} />
		</div>
		<div class="mid">
			<div class="lab">
				{#if member}<Avatar name={member.displayName} color={member.color} size={22} />{/if}
				<span class="caps"
					>{words.nextUp}{#if member}{` · ${member.displayName}`}{/if}</span
				>
				{#if onmode}
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
			<h2 class="title font-display">
				{#if item.href}<a href={item.href}>{item.title}</a>{:else}{item.title}{/if}
			</h2>
			<div class="meta">
				<span>{meta}</span>
				{#if pill}<span class="pill">{pill}</span>{/if}
			</div>
		</div>
		{#if !compact}
			<div class="then" data-testid="then">
				<span class="caps">{thenTitle}</span>
				{#if then.length > 0}
					<ol>
						{#each then as line (line.id)}
							<li>
								<svelte:element
									this={line.href ? 'a' : 'div'}
									href={line.href || undefined}
									class="line"
								>
									<time class="font-display">{line.time}</time>
									<i style:background-color={line.color || 'var(--ink-soft)'} aria-hidden="true"
									></i>
									<b>{line.title}</b>
								</svelte:element>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="none">{thenNone}</p>
				{/if}
			</div>
		{/if}
	</section>
</div>

<style>
	.board {
		display: grid;
		grid-template-columns: minmax(8.5rem, 12.5rem) minmax(0, 1fr) minmax(13rem, 18.75rem);
		min-height: 124px;
		overflow: hidden;
		border-radius: 18px;
		background: var(--surface);
		box-shadow: var(--shadow-lit);
	}
	.wrap {
		container-type: inline-size;
	}
	/* A narrower board (the 1024 px band): the countdown and "Then" give the title room. */
	@container (max-width: 56rem) {
		.board:not(.compact) {
			grid-template-columns: 9rem minmax(0, 1fr) minmax(11rem, 14rem);
		}
	}
	.compact {
		grid-template-columns: 6.75rem minmax(0, 1fr);
		min-height: 0;
	}
	.cnt {
		display: grid;
		place-items: center;
		padding: 12px;
		background: var(--accent);
		color: var(--on-accent);
	}
	/* The countdown is centred on the board (it is right-aligned on the other styles' hero). */
	.cnt :global(.countdown) {
		justify-items: center;
		text-align: center;
	}
	.cnt :global(.countdown .n) {
		font-stretch: 68%;
		font-weight: 800;
	}
	/* The phone's narrow cell: "1 hr 46" on one line. */
	.compact .cnt :global(.countdown.duration .n) {
		font-size: calc(var(--ramp-countdown) * 0.6);
		line-height: 1;
	}
	.mid {
		display: grid;
		align-content: center;
		gap: 6px;
		min-width: 0;
		padding: 16px 24px;
	}
	.compact .mid {
		padding: 14px 16px;
	}
	.lab {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-height: 28px;
	}
	.caps {
		font-size: var(--ramp-label, 0.71875rem);
		font-weight: 700;
		font-stretch: 80%;
		letter-spacing: var(--ramp-label-tracking, 0.16em);
		text-transform: uppercase;
		color: var(--ink-soft);
	}
	.toggle {
		margin-inline-start: auto;
	}
	@container (max-width: 40rem) {
		.toggle {
			flex-basis: 100%;
			margin-inline-start: 0;
		}
	}
	.title {
		margin: 0;
		font-size: var(--ramp-hero, 2.25rem);
		font-weight: 800;
		font-stretch: 92%;
		line-height: 1;
		letter-spacing: -0.015em;
		/* Words stay whole: only a single word longer than the whole line breaks. */
		overflow-wrap: break-word;
		color: var(--ink);
	}
	.title a {
		color: inherit;
		text-decoration: none;
	}
	.title a:hover {
		text-decoration: underline;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--ink-soft);
	}
	/* The pill on the surface: a small piece of the accent with its own text colour. */
	.pill {
		display: inline-flex;
		align-items: center;
		height: 28px;
		padding: 0 12px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 0.6875rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		white-space: nowrap;
	}
	.then {
		display: grid;
		align-content: center;
		gap: 8px;
		min-width: 0;
		padding: 14px 20px;
		border-inline-start: 1px solid var(--line);
	}
	.then ol {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.then .line {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		min-height: 26px;
		font-size: 0.8125rem;
		color: var(--ink);
		text-decoration: none;
	}
	.then a.line:hover b {
		text-decoration: underline;
	}
	.then time {
		font-size: 0.9375rem;
		font-weight: 800;
		font-stretch: 75%;
		font-variant-numeric: tabular-nums;
	}
	.then i {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}
	.then b {
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.none {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--ink-soft);
	}
</style>
