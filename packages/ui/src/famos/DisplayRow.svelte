<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A row on a family display. Variants: `idle` recedes into the wall, `lit` is a
	 * card, `now` is a lit card ringed in the `now` color, `past` is idle and dimmed,
	 * `empty` is a quiet idle line for an empty section.
	 */
	let {
		variant = 'idle',
		time,
		colors = [],
		lead,
		title,
		note,
		subtitle,
		trail,
		class: className = '',
	}: {
		variant?: 'idle' | 'lit' | 'now' | 'past' | 'empty';
		/** Leading time text ("09:30", "All day"). */
		time?: string;
		/** Member colors, drawn as small dots (only pass them when names may be shown). */
		colors?: readonly string[];
		/** Leading visual, e.g. a colored disc. */
		lead?: Snippet;
		title: string;
		/** Short soft text right after the title (a quantity). */
		note?: string;
		subtitle?: string;
		/** Small text or icon at the end of the row. */
		trail?: Snippet;
		class?: string;
	} = $props();

	const looks = {
		idle: 'bg-idle text-ink-soft',
		lit: 'bg-surface text-ink shadow-lit',
		now: 'bg-surface text-ink shadow-lit inset-ring-2 inset-ring-now/70',
		past: 'bg-idle text-ink-soft opacity-60',
		empty: 'bg-idle text-ink-soft',
	} as const;
</script>

<div class="flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 {looks[variant]} {className}">
	{#if time !== undefined}
		<span class="w-[4.75rem] shrink-0 text-sm font-bold whitespace-nowrap tabular-nums">{time}</span
		>
	{/if}
	{#if colors.length}
		<span class="flex shrink-0 gap-0.5" aria-hidden="true">
			{#each colors as color (color)}
				<span class="size-2.5 rounded-full" style:background-color={color}></span>
			{/each}
		</span>
	{/if}
	{#if lead}{@render lead()}{/if}
	<span class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-px">
		<span class="flex min-w-0 items-baseline gap-1.5">
			<b
				class="truncate text-[15px] leading-tight {variant === 'empty'
					? 'text-ink-soft font-semibold'
					: 'text-ink font-bold'}">{title}</b
			>
			{#if note}<span class="text-ink-soft shrink-0 text-[13px] font-semibold">{note}</span>{/if}
		</span>
		{#if subtitle}<small class="text-ink-soft truncate text-xs">{subtitle}</small>{/if}
	</span>
	{#if trail}<span class="text-ink-soft flex shrink-0 items-center gap-1.5 text-xs"
			>{@render trail()}</span
		>{/if}
</div>
