<script lang="ts">
	/**
	 * The switch alone: a native checkbox with role="switch" (keyboards, screen readers and forms
	 * work without extra code) and its track. Put it in a `<label>` with the words, or give it
	 * `label` when the words are elsewhere (a column head). `SwitchRow` is the setting row around
	 * it; a matrix row puts several side by side.
	 */
	let {
		id,
		checked = $bindable(false),
		disabled = false,
		label,
		describedby,
		onchange,
	}: {
		id?: string;
		checked?: boolean;
		disabled?: boolean;
		/** The accessible name, when no label around the switch says what it is for. */
		label?: string;
		/** The id of a hint that describes it. */
		describedby?: string;
		onchange?: (checked: boolean) => void;
	} = $props();
</script>

<input
	{id}
	type="checkbox"
	role="switch"
	class="peer sr-only"
	bind:checked
	{disabled}
	aria-label={label}
	aria-describedby={describedby}
	onchange={() => onchange?.(checked)}
/>
<span
	aria-hidden="true"
	class="bg-ink-soft/35 peer-checked:bg-now peer-focus-visible:ring-ink after:bg-surface after:shadow-lit relative h-7 w-12 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:transition-transform peer-checked:after:translate-x-5 motion-reduce:transition-none motion-reduce:after:transition-none"
></span>
