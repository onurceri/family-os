<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A section of a family display: icon, title and a count on one line, then rows.
	 * Sized in the display stage's own pixels (the stage is scaled to the screen).
	 */
	let {
		title,
		count,
		icon,
		children,
	}: {
		title: string;
		/** Short text on the right, e.g. "2 open tasks". */
		count?: string;
		/** The section's icon, drawn in its semantic color (`text-now`, `text-sun` …). */
		icon?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="grid min-w-0 content-start gap-2.5">
	<div class="flex items-center gap-2">
		{#if icon}<span class="flex shrink-0 items-center [&>svg]:size-5" aria-hidden="true"
				>{@render icon()}</span
			>{/if}
		<h2 class="min-w-0 truncate text-[1.0625rem] leading-tight font-extrabold">{title}</h2>
		{#if count}<span class="text-ink-soft ml-auto shrink-0 text-[0.8125rem]">{count}</span>{/if}
	</div>
	{@render children()}
</section>
