<script lang="ts">
	import type { SlotProps } from '@famos/ui/slots';
	import type { Values } from '../contract/index.js';
	import { loadValues } from './data.js';
	import { useHomeAssistant } from './i18n.js';
	import { sayValue, TONE_CLASS } from './say.js';

	/**
	 * Family display page: everything the family chose to show from Home Assistant, one row each,
	 * label and value, in two columns from 1280 px and one below. It fits its box without
	 * scrolling: the rows that do not fit are left out and counted ("3 more"). Never a switch or a
	 * button. It reads again each time it comes round.
	 */
	let { shown }: SlotProps['display.page'] = $props();
	const { app, t } = useHomeAssistant();

	let values = $state<Values | null>(null);
	async function load() {
		try {
			values = await loadValues();
		} catch {
			// Keep what is on screen; the next time round tries again.
		}
	}
	const items = $derived(values?.status === 'ok' ? values.items : []);

	$effect(() => {
		if (!shown) return;
		void load();
		const refresh = setInterval(() => void load(), 60_000);
		return () => clearInterval(refresh);
	});
	$effect(() => app.onEvent('homeassistant.', () => void load()));

	/* ───────────── fitting the box ───────────── */

	let box = $state<HTMLDivElement>();
	let note = $state<HTMLParagraphElement>();
	/** How many rows fit; null until measured. Rows past it stay laid out (so measuring stays
	    stable) but are not drawn. */
	let fitting = $state<number | null>(null);

	function measure() {
		if (!box) return;
		const rows = [...box.querySelectorAll<HTMLElement>('[data-row]')];
		const height = box.clientHeight;
		const bottom = (row: HTMLElement) => row.offsetTop + row.offsetHeight;
		if (rows.every((row) => bottom(row) <= height + 0.5)) {
			fitting = rows.length;
			return;
		}
		// Something is left out: the line saying how many sits at the foot.
		const limit = height - (note?.offsetHeight ?? 0);
		const count = rows.findIndex((row) => bottom(row) > limit + 0.5);
		fitting = Math.max(count, 0);
	}
	let frame = 0;
	const later = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(measure);
	};
	$effect(() => {
		if (!box) return;
		const observer = new ResizeObserver(later);
		observer.observe(box);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	});
	// The rows changed (new values, a new label): measured again.
	$effect(() => {
		void items.map((item) => `${item.id}${item.label}${JSON.stringify(item.value)}`).join();
		later();
	});

	const left = $derived(fitting === null ? 0 : Math.max(items.length - fitting, 0));
</script>

<div class="relative size-full" bind:this={box}>
	{#if values?.status === 'ok' && items.length > 0}
		<ul class="grid content-start gap-3 min-[1280px]:grid-cols-2">
			{#each items as item, i (item.id)}
				{@const said = sayValue(app, t, item.value)}
				<li
					data-row
					class="bg-surface shadow-lit flex min-w-0 items-center justify-between gap-6 rounded-xl px-6 py-4"
					style:visibility={fitting === null || i >= fitting ? 'hidden' : undefined}
				>
					<b class="type-record truncate">{item.label}</b>
					<span class="shrink-0 text-2xl font-bold {TONE_CLASS[said.tone]}">{said.text}</span>
				</li>
			{/each}
		</ul>
	{:else if values}
		<p class="bg-idle text-ink-soft rounded-lg px-5 py-4 text-xl">
			{values.status === 'ok' ? t('page_empty') : t('page_unavailable')}
		</p>
	{/if}
	<p
		bind:this={note}
		class="text-ink-soft absolute inset-x-0 bottom-0 px-1 text-lg font-semibold"
		class:invisible={left === 0}
	>
		{t('page_more', { n: left || 1 })}
	</p>
</div>
