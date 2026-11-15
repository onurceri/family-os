<script lang="ts">
	/**
	 * Equal tiles for choosing one of two to six levels (a fan's speeds, later presets): 48 px
	 * high, `idle`, the chosen one `surface` with `shadow-lit`. A radiogroup with one tab stop;
	 * arrow keys move the focus, Space or Enter chooses.
	 */
	let {
		count,
		value,
		label,
		tileLabel,
		disabled = false,
		onpick,
	}: {
		count: number;
		/** The chosen level, 1-based; 0 or null for none. */
		value: number | null;
		/** Accessible name of the group (already translated). */
		label: string;
		/** Accessible name of one tile ("Speed 2"). */
		tileLabel: (level: number) => string;
		disabled?: boolean;
		onpick: (level: number) => void;
	} = $props();

	let group = $state<HTMLElement>();
	const levels = $derived(Array.from({ length: count }, (_, i) => i + 1));
	const tabStop = $derived(value && value >= 1 && value <= count ? value : 1);

	function onkeydown(e: KeyboardEvent) {
		if (!group) return;
		const rtl = getComputedStyle(group).direction === 'rtl';
		const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
		const back = e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
		let to: number | null = null;
		if (e.key === 'Home') to = 1;
		else if (e.key === 'End') to = count;
		else if (forward || back) {
			const at = Number(document.activeElement?.getAttribute('data-level') ?? tabStop);
			to = ((at - 1 + (forward ? 1 : -1) + count) % count) + 1;
		}
		if (to === null) return;
		e.preventDefault();
		group.querySelector<HTMLElement>(`[data-level="${to}"]`)?.focus();
	}
</script>

<div
	bind:this={group}
	role="radiogroup"
	aria-label={label}
	tabindex="-1"
	class="grid gap-2 outline-none"
	style="grid-template-columns: repeat({count}, minmax(0, 1fr))"
	{onkeydown}
>
	{#each levels as level (level)}
		<button
			type="button"
			role="radio"
			aria-checked={level === value}
			aria-label={tileLabel(level)}
			tabindex={level === tabStop ? 0 : -1}
			data-level={level}
			{disabled}
			onclick={() => onpick(level)}
			class="bg-idle text-ink-soft aria-checked:bg-surface aria-checked:text-ink aria-checked:shadow-lit aria-checked:ring-2 aria-checked:ring-ink focus-visible:ring-info h-12 cursor-pointer rounded-[var(--r-ctl)] text-[0.9375rem] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default disabled:opacity-45 motion-reduce:transition-none"
			>{level}</button
		>
	{/each}
</div>
