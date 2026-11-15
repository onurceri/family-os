<script lang="ts">
	import { Minus, Plus } from '@lucide/svelte';
	import { onDestroy } from 'svelte';

	/**
	 * A labelled number group of a sheet: a native range, − and + buttons and a readout of the
	 * value. Nothing is sent while the thumb moves. A release (`change`) commits at once; − and +
	 * commit after a short quiet, so five taps are one call. While it waits for the real state the
	 * readout says so, and the thumb never follows a live read while a finger is on it. Where the
	 * sheet asks first (`deferred`) every pick is handed up at once to be staged.
	 */
	let {
		label,
		value,
		min,
		max,
		step,
		format,
		emptyText,
		minLabel,
		maxLabel,
		switchingText,
		decreaseLabel,
		increaseLabel,
		busy = false,
		deferred = false,
		disabled = false,
		testid,
		onchoose,
	}: {
		label: string;
		/** What the thing reads now, or what was staged; null when it does not say. */
		value: number | null;
		/** The lowest value that may be chosen, the highest, and the grid of the slider. */
		min: number;
		max: number;
		step: number;
		/** The value in words ("60 %"). */
		format: (value: number) => string;
		/** The readout while the value is not known. */
		emptyText: string;
		/** Words under the ends of the slider ("Closed", "Open"). */
		minLabel?: string;
		maxLabel?: string;
		/** The readout while a switch is on its way. */
		switchingText: string;
		decreaseLabel: string;
		increaseLabel: string;
		busy?: boolean;
		deferred?: boolean;
		disabled?: boolean;
		testid?: string;
		onchoose: (value: number) => void;
	} = $props();

	/** Wait this long after the last tap of − or + before asking. */
	const QUIET_MS = 600;
	/** A choice that is never confirmed by a switch coming and going lets go after this long. */
	const GIVE_UP_MS = 15_000;

	let local = $state<number | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let giveUp: ReturnType<typeof setTimeout> | undefined;
	let waited = false;
	/** A finger (or a key) is on the slider. */
	let held = false;

	const clamp = (n: number) => Math.min(max, Math.max(min, n));
	/** The slider's own grid starts on a multiple of its step at or below the lowest value. */
	const floor = $derived(Math.floor(min / step) * step);
	const shown = $derived(local ?? value);
	const thumb = $derived(shown ?? floor);
	const readout = $derived(busy ? switchingText : shown === null ? emptyText : format(shown));

	function commit(next: number) {
		clearTimeout(timer);
		timer = undefined;
		const chosen = clamp(next);
		if (deferred) {
			local = null;
			onchoose(chosen);
			return;
		}
		local = chosen;
		clearTimeout(giveUp);
		giveUp = setTimeout(() => (local = null), GIVE_UP_MS);
		onchoose(chosen);
	}

	function nudge(by: number) {
		const next = clamp((shown ?? floor) + by);
		if (next === shown) return;
		if (deferred) return commit(next);
		local = next;
		clearTimeout(timer);
		timer = setTimeout(() => commit(next), QUIET_MS);
	}

	// What was asked is shown until the switch has come and gone, then the real value again.
	$effect(() => {
		if (busy) waited = true;
		else if (waited) {
			waited = false;
			// Never under a finger: the thumb stays where the person holds it.
			if (!held) local = null;
			clearTimeout(giveUp);
		}
	});

	onDestroy(() => {
		clearTimeout(giveUp);
		// A tap that is still waiting for its quiet is not lost when the sheet closes.
		if (timer !== undefined && local !== null) commit(local);
	});

	const buttonClass =
		'bg-idle text-ink hover:bg-idle/70 focus-visible:ring-ink grid size-[var(--ctl)] shrink-0 cursor-pointer place-items-center rounded-[var(--r-ctl)] focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default disabled:opacity-45';
</script>

<div class="grid gap-1" data-testid={testid}>
	<div class="flex items-center justify-between gap-3">
		<span class="text-[0.875rem] font-semibold">{label}</span>
		<div class="flex items-center gap-1">
			<button
				type="button"
				class={buttonClass}
				aria-label={decreaseLabel}
				disabled={disabled || (shown ?? floor) <= min}
				onclick={() => nudge(-step)}><Minus class="size-4" aria-hidden="true" /></button
			>
			<span
				class="text-ink min-w-16 text-center text-[0.9375rem] font-semibold tabular-nums"
				aria-live="polite"
				data-testid="ha-level-readout">{readout}</span
			>
			<button
				type="button"
				class={buttonClass}
				aria-label={increaseLabel}
				disabled={disabled || (shown ?? floor) >= max}
				onclick={() => nudge(step)}><Plus class="size-4" aria-hidden="true" /></button
			>
		</div>
	</div>
	<input
		type="range"
		class="accent-now h-[var(--ctl)] w-full cursor-pointer disabled:cursor-default disabled:opacity-45"
		aria-label={label}
		aria-valuetext={readout}
		min={floor}
		{max}
		{step}
		value={thumb}
		{disabled}
		onpointerdown={() => (held = true)}
		onpointerup={() => (held = false)}
		onpointercancel={() => (held = false)}
		oninput={(e) => (local = clamp(Number(e.currentTarget.value)))}
		onchange={(e) => {
			held = false;
			commit(Number(e.currentTarget.value));
		}}
	/>
	{#if minLabel || maxLabel}
		<div class="text-ink-soft flex justify-between text-[0.75rem]" aria-hidden="true">
			<span>{minLabel}</span>
			<span>{maxLabel}</span>
		</div>
	{/if}
</div>
