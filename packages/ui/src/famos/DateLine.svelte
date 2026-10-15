<script lang="ts">
	import type { TodayFormat } from './today-v3.js';

	/**
	 * The date under the clock: the weekday in tracked caps over the day and month,
	 * in the serif at `--ramp-date` (`serif`, Broadsheet's italic) or bold in the body face
	 * (`plain`). Both from `Intl` in the date locale: the reader's words, the region's order.
	 */
	let {
		now,
		format,
		variant = 'serif',
		heading = false,
	}: {
		now: number;
		format: TodayFormat;
		variant?: 'serif' | 'plain';
		/** The page's `h1` (Today): the date is what the page is about. */
		heading?: boolean;
	} = $props();

	const weekday = $derived(
		new Intl.DateTimeFormat(format.dateLocale, {
			weekday: 'long',
			timeZone: format.timeZone,
		}).format(now),
	);
	const date = $derived(
		new Intl.DateTimeFormat(format.dateLocale, {
			day: 'numeric',
			month: 'long',
			timeZone: format.timeZone,
		}).format(now),
	);
</script>

<svelte:element this={heading ? 'h1' : 'p'} class="dateline {variant}" data-testid="date-line">
	<span class="weekday">{weekday}</span>
	<span class="date {variant === 'serif' ? 'font-serif' : ''}">{date}</span>
</svelte:element>

<style>
	.dateline {
		display: grid;
		gap: 2px;
		margin: 0;
		font-size: inherit;
		font-weight: inherit;
		color: var(--ink);
	}
	.weekday {
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}
	.date {
		font-size: var(--ramp-date, 1.75rem);
		line-height: 1.05;
	}
	.serif .date {
		font-style: italic;
		font-weight: 400;
	}
	.plain {
		gap: 0;
	}
	.plain .weekday {
		order: 2;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: none;
		color: var(--ink-soft);
	}
	.plain .date {
		font-weight: 700;
		letter-spacing: -0.01em;
	}
</style>
