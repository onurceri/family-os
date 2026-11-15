<script lang="ts">
	/**
	 * The on/off switch of a row and of a sheet: a 48 × 44 touch target whose track is 48 × 28,
	 * flush to the end of whatever holds it so every switch sits on one edge.
	 */
	let {
		on,
		label,
		disabled = false,
		onclick,
		testid,
	}: {
		on: boolean;
		/** Accessible name (already translated). */
		label: string;
		disabled?: boolean;
		onclick: () => void;
		testid?: string;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={on}
	aria-label={label}
	{disabled}
	{onclick}
	class="group focus-visible:ring-ink grid min-h-11 w-12 shrink-0 cursor-pointer place-items-center rounded-full focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
	data-testid={testid}
>
	<span
		aria-hidden="true"
		class="bg-ink-soft/35 group-aria-checked:bg-now after:bg-surface after:shadow-lit relative h-7 w-12 rounded-full transition-colors after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:transition-transform group-aria-checked:after:translate-x-5 motion-reduce:transition-none motion-reduce:after:transition-none"
	></span>
</button>
