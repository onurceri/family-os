<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import type { HTMLSelectAttributes } from 'svelte/elements';

	/**
	 * A native select dressed like the rest of the controls: `idle` fill, `--ctl` tall, a chevron
	 * at the end. The native list stays, so keyboards, screen readers and phones work as they
	 * should.
	 */
	let {
		value = $bindable(),
		children,
		class: className = '',
		...rest
	}: { children: Snippet; class?: string } & HTMLSelectAttributes = $props();
</script>

<div class="relative w-full {className}">
	<select
		bind:value
		class="bg-idle text-ink focus-visible:ring-info h-[var(--ctl)] w-full appearance-none rounded-[var(--r-ctl)] border-0 ps-3 pe-9 text-[0.9375rem] outline-none focus-visible:ring-2"
		{...rest}
	>
		{@render children()}
	</select>
	<ChevronDown
		class="text-ink-soft pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2"
		aria-hidden="true"
	/>
</div>
