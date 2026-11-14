<script lang="ts">
	import Ring from './Ring.svelte';
	import {
		type Countdown,
		type CountdownWords,
		NEXT_UP_DURATION_FROM,
		showCountdown,
		type TodayFormat,
	} from './today-v3.js';

	/**
	 * The hero's countdown: the minutes as the biggest number on the page
	 * with the unit under it; a duration at a smaller size with "to go"; the start time with
	 * "starts"; "now" once started. `ring` (Wall) draws it inside a ring on the accent that
	 * empties over the last hour. Decorative for screen readers: the hero carries the name
	 * ("Piano lesson, 15:45, in 25 minutes").
	 */
	let {
		count,
		format,
		words,
		variant = 'number',
		size = 128,
	}: {
		count: Countdown;
		format: TodayFormat;
		words: CountdownWords;
		variant?: 'number' | 'ring';
		/** The ring's size in px. */
		size?: number;
	} = $props();

	const view = $derived(showCountdown(count, format, words));
	const fraction = $derived(
		count.kind === 'minutes' ? count.minutes / NEXT_UP_DURATION_FROM : count.kind === 'now' ? 0 : 1,
	);
</script>

<span
	class="countdown {variant === 'ring' ? 'circled' : 'number'} {view.kind}"
	style:width={variant === 'ring' ? `${size}px` : undefined}
	style:height={variant === 'ring' ? `${size}px` : undefined}
	aria-hidden="true"
	data-testid="countdown"
>
	{#if variant === 'ring'}
		<Ring {fraction} text="" {size} stroke={Math.max(3, Math.round(size / 27))} onAccent />
	{/if}
	<span class="n font-display"
		>{#if view.parts}{view.parts.hours}<small class="hu">{view.parts.unit}</small>{view.parts
				.minutes}{:else}{view.value}{/if}</span
	>
	{#if view.caption}<span class="u">{view.caption}</span>{/if}
</span>

<style>
	.countdown {
		display: grid;
		justify-items: end;
		text-align: end;
		color: inherit;
		white-space: nowrap;
	}
	.n {
		font-size: var(--ramp-countdown, 8rem);
		font-weight: 600;
		line-height: 0.8;
		letter-spacing: -0.01em;
		font-variant-numeric: tabular-nums;
	}
	.duration .n {
		font-size: calc(var(--ramp-countdown, 8rem) * 0.8);
	}
	/* The unit between the hours and the minutes of "1 hr 46": small caps on the baseline. */
	.hu {
		margin: 0 0.14em;
		font-size: 0.26em;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.time .n {
		/* A start time is wide: in a narrow hero (its container) it gives the title room to keep its words whole. */
		font-size: min(calc(var(--ramp-countdown, 8rem) * 0.75), 13cqi);
	}
	.now .n {
		font-size: calc(var(--ramp-countdown, 8rem) * 0.6);
		text-transform: uppercase;
	}
	.u {
		margin-top: 8px;
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	/* In the ring the text is sized by the ring too (`cqi`: a share of its width), so a 12-hour
	   time, a longer word or a larger text size never runs into the circle. */
	.circled {
		container-type: inline-size;
		position: relative;
		display: grid;
		place-items: center;
		align-content: center;
		justify-items: center;
		text-align: center;
	}
	.circled > :global(.meter) {
		position: absolute;
		inset: 0;
		margin: auto;
	}
	.circled .n {
		position: relative;
		font-size: min(calc(var(--ramp-countdown, 6rem) * 0.54), 42cqi);
		font-weight: 800;
		line-height: 0.9;
		letter-spacing: -0.04em;
	}
	.circled.duration .n {
		font-size: min(calc(var(--ramp-countdown, 6rem) * 0.42), 30cqi);
		letter-spacing: -0.02em;
	}
	.circled.time .n,
	.circled.now .n {
		font-size: min(calc(var(--ramp-countdown, 6rem) * 0.31), 17cqi);
	}
	.circled .u {
		position: relative;
		margin-top: 2px;
		font-size: min(0.75rem, 10cqi);
	}
</style>
