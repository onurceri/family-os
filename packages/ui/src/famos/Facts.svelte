<script lang="ts">
	/**
	 * Totals of an overview: a card with two to four facts, each a 12/600 uppercase label above a
	 * value in the style's display face (`type-figure`), so the numbers carry the page's voice.
	 */
	let {
		items,
		label,
	}: {
		items: { label: string; value: string }[];
		/** Accessible name of the group (already translated). */
		label?: string;
	} = $props();
</script>

<dl class="facts" aria-label={label} data-surface="card">
	{#each items as item (item.label)}
		<div>
			<dt>{item.label}</dt>
			<dd class="type-figure">{item.value}</dd>
		</div>
	{/each}
</dl>

<style>
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 16px 24px;
		margin: 0;
		padding: 16px 20px;
		background: var(--surface);
		border-radius: var(--r-card);
		box-shadow: inset 0 0 0 1px var(--line);
		color: var(--ink);
	}
	div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	dt {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
