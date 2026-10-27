<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * An on/off setting: label, optional hint and a switch. A native checkbox with role="switch",
	 * so keyboards, screen readers and forms work without extra code. `end` goes after the switch,
	 * outside the label, so a button there (a row's `...` menu) never toggles it. The text starts 12 px
	 * in, as in a `Row`, so switch rows and plain rows line up in the cards of one page.
	 *
	 * With `onopen` the row is a thing with a switch rather than a setting: its text opens the
	 * thing (rows open on tap) and only the switch itself toggles, so a tap on the name of a
	 * switch that acts for everyone never flips it by accident.
	 */
	let {
		id,
		label,
		hint,
		checked = $bindable(false),
		disabled = false,
		onchange,
		onopen,
		end,
		oneLine = false,
	}: {
		id: string;
		label: string;
		hint?: string;
		checked?: boolean;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
		/** Opens what the row is about; the text becomes its button and only the switch toggles. */
		onopen?: () => void;
		end?: Snippet;
		/** Keeps the label and the hint to one line each (ellipsis), like a row's title and meta. */
		oneLine?: boolean;
	} = $props();
</script>

{#snippet text()}
	<span class="grid min-w-0 flex-1 gap-0.5">
		<span class="font-semibold" class:truncate={oneLine}>{label}</span>
		{#if hint}<small
				id="{id}-hint"
				class="text-ink-soft text-xs"
				class:truncate={oneLine}
				title={oneLine ? hint : undefined}>{hint}</small
			>{/if}
	</span>
{/snippet}

{#snippet control()}
	<input
		{id}
		type="checkbox"
		role="switch"
		class="peer sr-only"
		bind:checked
		{disabled}
		aria-label={onopen ? label : undefined}
		aria-describedby={onopen && hint ? `${id}-hint` : undefined}
		onchange={() => onchange?.(checked)}
	/>
	<span
		aria-hidden="true"
		class="bg-ink-soft/35 peer-checked:bg-now peer-focus-visible:ring-ink after:bg-surface after:shadow-lit relative h-7 w-12 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:transition-transform peer-checked:after:translate-x-5 motion-reduce:transition-none motion-reduce:after:transition-none"
	></span>
{/snippet}

{#snippet row()}
	{#if onopen}
		<div class="flex min-h-13 items-stretch gap-3">
			<button
				type="button"
				class="flex min-w-0 flex-1 cursor-pointer items-center py-3 ps-3 text-start"
				onclick={onopen}
				data-testid="{id}-open"
			>
				{@render text()}
			</button>
			<label
				for={id}
				class="flex shrink-0 items-center px-3 {disabled
					? 'cursor-not-allowed opacity-60'
					: 'cursor-pointer'}"
			>
				{@render control()}
			</label>
		</div>
	{:else}
		<label
			for={id}
			class="flex min-h-13 cursor-pointer items-center gap-6 px-3 py-3 {disabled
				? 'cursor-not-allowed opacity-60'
				: ''}"
		>
			{@render text()}
			{@render control()}
		</label>
	{/if}
{/snippet}

{#if end}
	<div class="flex items-center gap-1 pe-3">
		<div class="min-w-0 flex-1">{@render row()}</div>
		{@render end()}
	</div>
{:else}
	{@render row()}
{/if}
