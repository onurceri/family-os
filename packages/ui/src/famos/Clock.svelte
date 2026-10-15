<script lang="ts">
	import type { TodayFormat } from './today-v3.js';

	/**
	 * The clock of Today: the time in the display face at the style's `--ramp-clock`
	 * (a composition may set the property smaller, on a phone). A 12-hour family's day period
	 * ("PM") is set small beside it. `now` comes from the page, which ticks it.
	 */
	let { now, format }: { now: number; format: TodayFormat } = $props();

	const parts = $derived(
		new Intl.DateTimeFormat(format.dateLocale, {
			hour: format.hourCycle === 'h12' ? 'numeric' : '2-digit',
			minute: '2-digit',
			timeZone: format.timeZone,
			hourCycle: format.hourCycle,
		}).formatToParts(now),
	);
	const time = $derived(
		parts
			.filter((p) => p.type !== 'dayPeriod')
			.map((p) => p.value)
			.join('')
			.trim(),
	);
	const period = $derived(parts.find((p) => p.type === 'dayPeriod')?.value ?? '');
</script>

<time class="clock font-display" datetime={new Date(now).toISOString()} data-testid="clock"
	>{time}{#if period}<span class="period">{period}</span>{/if}</time
>

<style>
	.clock {
		display: inline-flex;
		align-items: baseline;
		gap: 0.08em;
		font-size: var(--ramp-clock, 7.5rem);
		font-weight: 600;
		line-height: 0.85;
		letter-spacing: -0.01em;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		white-space: nowrap;
	}
	.period {
		font-size: 0.28em;
		font-weight: 700;
		letter-spacing: 0.04em;
	}
</style>
