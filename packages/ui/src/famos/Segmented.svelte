<script lang="ts" module>
	export type SegmentedOption = { value: string; label: string; disabled?: boolean };
</script>

<script lang="ts">
	/**
	 * One style for every choice of up to four options. A
	 * radiogroup: one tab stop, arrow keys move and choose, Home and End jump.
	 */
	let {
		options,
		value = $bindable(),
		label,
		size = 'md',
		grow = false,
		onchange,
	}: {
		options: SegmentedOption[];
		value?: string;
		/** Accessible name of the group (already translated). */
		label: string;
		size?: 'md' | 'sm';
		/** Options share the width (phones, setting rows). */
		grow?: boolean;
		onchange?: (value: string) => void;
	} = $props();

	let group = $state<HTMLElement>();
	const tabStop = $derived(
		options.find((o) => o.value === value && !o.disabled)?.value ??
			options.find((o) => !o.disabled)?.value,
	);

	function choose(next: string) {
		if (next === value) return;
		value = next;
		onchange?.(next);
	}

	function onkeydown(e: KeyboardEvent) {
		const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
		if (!keys.includes(e.key) || !group) return;
		const enabled = options.filter((o) => !o.disabled);
		if (enabled.length === 0) return;
		const current = (document.activeElement as HTMLElement | null)?.dataset.value;
		const at = enabled.findIndex((o) => o.value === current);
		const rtl = getComputedStyle(group).direction === 'rtl';
		let to = at < 0 ? 0 : at;
		if (e.key === 'Home') to = 0;
		else if (e.key === 'End') to = enabled.length - 1;
		else {
			const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
			to = (to + (forward ? 1 : -1) + enabled.length) % enabled.length;
		}
		e.preventDefault();
		const target = enabled[to] as SegmentedOption;
		choose(target.value);
		for (const b of group.querySelectorAll<HTMLElement>('[data-value]')) {
			if (b.dataset.value === target.value) b.focus();
		}
	}
</script>

<div
	bind:this={group}
	role="radiogroup"
	aria-label={label}
	tabindex="-1"
	class="seg"
	class:sm={size === 'sm'}
	class:grow
	{onkeydown}
>
	{#each options as o (o.value)}
		<button
			type="button"
			role="radio"
			aria-checked={o.value === value}
			tabindex={o.value === tabStop ? 0 : -1}
			disabled={o.disabled}
			data-value={o.value}
			class:on={o.value === value}
			onclick={() => choose(o.value)}>{o.label}</button
		>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		padding: 3px;
		border-radius: 999px;
		background: var(--idle);
		height: var(--ctl);
		max-width: 100%;
		outline: none;
	}
	.sm {
		height: 36px;
	}
	.grow {
		display: flex;
		width: 100%;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 14px;
		border: 0;
		border-radius: 999px;
		background: none;
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink-soft);
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out;
	}
	.sm button {
		padding: 0 12px;
		font-size: 13px;
	}
	.grow button {
		flex: 1;
	}
	button.on {
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-lit);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	@media (prefers-reduced-motion: reduce) {
		button {
			transition: none;
		}
	}
</style>
