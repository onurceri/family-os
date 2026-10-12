<script lang="ts">
	import { onDestroy } from 'svelte';

	/**
	 * Two-tap confirmation (Ev Işığı): the first tap arms the button and shows `confirmLabel`;
	 * a second tap within `windowMs` runs `onconfirm`. Waiting, or leaving, disarms it. The danger
	 * look (design system v2 section 5.1): `destructive` text, a filled `destructive` once armed.
	 */
	let {
		label,
		confirmLabel,
		onconfirm,
		windowMs = 4000,
		size = 'sm',
		disabled = false,
		look,
	}: {
		label: string;
		confirmLabel: string;
		onconfirm: () => void | Promise<void>;
		windowMs?: number;
		size?: 'sm' | 'md';
		disabled?: boolean;
		/**
		 * Classes that replace the danger look, for a confirmation that is not destructive (the
		 * second tap on an approval that may add a duplicate).
		 */
		look?: string;
	} = $props();

	let armed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function click() {
		if (!armed) {
			armed = true;
			clearTimeout(timer);
			timer = setTimeout(() => (armed = false), windowMs);
			return;
		}
		armed = false;
		clearTimeout(timer);
		void onconfirm();
	}

	onDestroy(() => clearTimeout(timer));
</script>

<button
	type="button"
	{disabled}
	onclick={click}
	onblur={() => (armed = false)}
	aria-live="polite"
	data-armed={armed}
	class={look
		? ['rounded-lg font-bold disabled:opacity-50', look]
		: [
				'rounded-[var(--r-ctl)] font-semibold transition-colors outline-none focus-visible:shadow-[0_0_0_2px_var(--wall),0_0_0_4px_var(--info)] disabled:opacity-50 motion-reduce:transition-none',
				size === 'sm' ? 'min-h-11 px-3 text-sm' : 'min-h-[var(--ctl)] px-4 text-[15px]',
				armed
					? 'bg-destructive text-on-color'
					: 'text-destructive hover:bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)]',
			]}
>
	{armed ? confirmLabel : label}
</button>
