<script lang="ts" module>
	import type { RepeatPreset } from './forms.js';

	export type { RepeatPreset };
	export interface RepeatLabels {
		none: string;
		daily: string;
		weekly: string;
		monthly: string;
		custom: string;
		until: string;
	}
</script>

<script lang="ts">
	import { Input } from '../components/input/index.js';
	import { Label } from '../components/label/index.js';
	import { fieldAria } from './field-errors.js';
	import FieldError from './FieldError.svelte';

	/**
	 * Repeat presets (none / daily / weekly on chosen days / monthly) with an optional end date,
	 * shared by every form that schedules something. `custom` marks a rule outside the presets:
	 * it is shown but cannot be picked. Weekday codes are RRULE codes (`MO` … `SU`). `error` and
	 * `untilError` are reasons (translation keys) shown under the choice and the end date.
	 */
	let {
		preset = $bindable(),
		byDay = $bindable(),
		until = $bindable(),
		days,
		labels,
		min,
		idPrefix,
		error,
		untilError,
	}: {
		preset: RepeatPreset;
		byDay: string[];
		until: string;
		/** Weekdays in display order with localized short names. */
		days: readonly { code: string; label: string }[];
		labels: RepeatLabels;
		/** Earliest allowed end date (the start date). */
		min?: string;
		idPrefix: string;
		error?: string | undefined;
		untilError?: string | undefined;
	} = $props();

	const presets = $derived([
		{ value: 'none', label: labels.none },
		{ value: 'daily', label: labels.daily },
		{ value: 'weekly', label: labels.weekly },
		{ value: 'monthly', label: labels.monthly },
	] as const);

	function toggleDay(code: string) {
		const next = byDay.includes(code) ? byDay.filter((d) => d !== code) : [...byDay, code];
		byDay = days.map((d) => d.code).filter((c) => next.includes(c));
	}

	const chip = (on: boolean) =>
		`min-h-11 rounded-full px-3.5 text-sm font-bold transition-colors ${on ? 'bg-ink text-wall' : 'bg-idle text-ink-soft hover:text-ink'}`;
	const dayChip = (on: boolean) =>
		`min-h-11 min-w-11 rounded-full text-sm font-bold transition-colors ${on ? 'bg-ink text-wall' : 'bg-idle text-ink-soft hover:text-ink'}`;
</script>

<div class="grid gap-2">
	<div
		id="{idPrefix}-repeat"
		class="flex flex-wrap gap-2"
		{...fieldAria(preset === 'weekly' ? undefined : error, `${idPrefix}-repeat`)}
	>
		{#each presets as p (p.value)}
			<button
				type="button"
				aria-pressed={preset === p.value}
				onclick={() => (preset = p.value)}
				class={chip(preset === p.value)}
			>
				{p.label}
			</button>
		{/each}
		{#if preset === 'custom'}
			<span class="{chip(true)} inline-flex items-center">{labels.custom}</span>
		{/if}
	</div>
	{#if preset === 'weekly'}
		<div
			id="{idPrefix}-days"
			class="flex flex-wrap gap-1"
			role="group"
			aria-label={labels.weekly}
			{...fieldAria(error, `${idPrefix}-days`)}
		>
			{#each days as day (day.code)}
				<button
					type="button"
					aria-pressed={byDay.includes(day.code)}
					onclick={() => toggleDay(day.code)}
					class={dayChip(byDay.includes(day.code))}
				>
					{day.label}
				</button>
			{/each}
		</div>
		<FieldError for="{idPrefix}-days" {error} />
	{:else}
		<FieldError for="{idPrefix}-repeat" {error} />
	{/if}
	{#if preset !== 'none' && preset !== 'custom'}
		<div class="grid max-w-56 gap-1.5">
			<Label for="{idPrefix}-until">{labels.until}</Label>
			<Input
				id="{idPrefix}-until"
				type="date"
				bind:value={until}
				{min}
				{...fieldAria(untilError, `${idPrefix}-until`)}
			/>
			<FieldError for="{idPrefix}-until" error={untilError} />
		</div>
	{/if}
</div>
