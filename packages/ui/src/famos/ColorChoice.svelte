<script lang="ts">
	/**
	 * A row of colour swatches, one chosen (a radio group); 44 px targets. The caller passes the
	 * palette, so only colours that keep letters readable can be picked.
	 */
	let {
		value = $bindable(),
		colors,
		name,
		legend,
	}: { value: string; colors: readonly string[]; name: string; legend: string } = $props();
</script>

<fieldset class="grid gap-2">
	<legend class="text-sm font-semibold">{legend}</legend>
	<div class="grid w-fit grid-cols-4 gap-3">
		{#each colors as swatch (swatch)}
			<label
				class="has-[:focus-visible]:ring-info grid size-11 cursor-pointer place-items-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2 {value ===
				swatch
					? 'ring-ink ring-2 ring-offset-2'
					: ''}"
				style:background-color={swatch}
			>
				<input type="radio" class="sr-only" {name} value={swatch} bind:group={value} />
				<span class="sr-only">{swatch}</span>
			</label>
		{/each}
	</div>
</fieldset>
