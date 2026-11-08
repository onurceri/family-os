<script lang="ts">
	import type { Snippet } from 'svelte';

	/** A compact status pill in a family display's clock row (`display.status` slot). */
	let {
		alert = false,
		icon,
		children,
	}: {
		/** Needs a person's attention: `bg-attention`. */
		alert?: boolean;
		icon?: Snippet;
		children: Snippet;
	} = $props();
</script>

<span
	class="inline-flex items-center gap-1.5 rounded-full px-3 py-[7px] text-[0.8125rem] font-bold {alert
		? 'bg-attention text-on-color'
		: 'bg-surface text-ink shadow-lit'}"
>
	{#if icon}<span class="flex items-center [&>svg]:size-4" aria-hidden="true">{@render icon()}</span
		>{/if}
	{@render children()}
</span>
