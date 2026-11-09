<script lang="ts">
	/**
	 * A number you can read from the door: the value in the display face at
	 * `--ramp-big`, a title and an optional detail beside it ("21 · items to get · Milk, eggs…").
	 * The number is formatted in the family's format locale.
	 */
	let {
		value,
		formatLocale,
		title,
		detail,
		href,
	}: {
		value: number;
		formatLocale: string;
		title: string;
		detail?: string;
		/** Where the title leads (the list). */
		href?: string;
	} = $props();

	const number = $derived(
		new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 0 }).format(value),
	);
</script>

<div class="big-number" data-testid="big-number">
	<span class="n font-display">{number}</span>
	<span class="t">
		{#if href}<a {href}><b>{title}</b></a>{:else}<b>{title}</b>{/if}
		{#if detail}<small>{detail}</small>{/if}
	</span>
</div>

<style>
	.big-number {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: 14px;
		color: var(--ink);
	}
	.n {
		font-size: var(--ramp-big, 4rem);
		font-weight: 600;
		line-height: 0.85;
		font-variant-numeric: tabular-nums;
	}
	.t {
		display: grid;
		gap: 2px;
		min-width: 0;
		padding-top: 2px;
	}
	b {
		font-size: 0.9375rem;
		font-weight: 700;
	}
	a {
		color: inherit;
		text-decoration: none;
	}
	a:hover {
		text-decoration: underline;
	}
	small {
		font-size: 0.8125rem;
		line-height: 1.35;
		color: var(--ink-soft);
	}
</style>
