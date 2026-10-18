<script lang="ts">
	import type { SlotProps } from '@famos/ui/slots';
	import type { ShoppingItem, ShoppingList } from '../contract/index.js';
	import { loadItems, loadLists } from './data.js';
	import { columnsFor, MAX_LISTS, planLists, planSingle } from './display-shopping.js';
	import { useLists } from './i18n.js';

	/**
	 * Family display page: what is still to buy. One list fills the box in columns; several lists
	 * are a labelled column each (three at most). It fits its box without scrolling: what does not
	 * fit is left out and counted. Never a link or a button. It reads again each time it comes round.
	 */
	let { shown }: SlotProps['display.page'] = $props();
	const { app, t } = useLists();

	interface Column {
		id: string;
		name: string;
		/** Everything still to buy on the list. */
		items: ShoppingItem[];
	}
	/** The lists drawn (with something to buy, three at most) and how many more there are. */
	let drawn = $state<Column[] | null>(null);
	let hidden = $state(0);
	let failed = $state(false);
	async function load() {
		try {
			const lists: ShoppingList[] = (await loadLists()).filter((list) => list.openCount > 0);
			// Only the lists that are drawn need their items; the others are only counted.
			const columns = await Promise.all(
				lists.slice(0, MAX_LISTS).map(async (list) => ({
					id: list.id,
					name: list.name || t('default_list'),
					items: (await loadItems(list.id)).filter((item) => item.doneAt === null),
				})),
			);
			drawn = columns.filter((column) => column.items.length > 0);
			hidden = Math.max(0, lists.length - MAX_LISTS);
			failed = false;
		} catch {
			// Keep what is on screen; the next time round tries again.
			failed = true;
		}
	}
	$effect(() => {
		if (!shown) return;
		void load();
		const refresh = setInterval(() => void load(), 5 * 60_000);
		return () => clearInterval(refresh);
	});
	$effect(() => app.onEvent('lists.shopping.', () => void load()));

	/* ───────────── fitting the box ───────────── */

	const GAP = 12;
	let width = $state(0);
	let box = $state<HTMLDivElement>();
	let boxHeight = $state(0);
	let noteHeight = $state(0);
	/** The measured heights of one item row and one label; null until the first rows are drawn. */
	let row = $state<number | null>(null);
	let head = $state(0);

	function measure() {
		if (!box) return;
		const first = box.querySelector<HTMLElement>('[data-row]');
		if (first) row = first.offsetHeight;
		head = box.querySelector<HTMLElement>('[data-head]')?.offsetHeight ?? 0;
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
	$effect(() => {
		void drawn;
		later();
	});

	const lists = $derived(drawn ?? []);
	const single = $derived(lists.length === 1 && hidden === 0);
	const measures = $derived({ height: boxHeight, row: row ?? 0, gap: GAP, note: noteHeight });
	const cols = $derived(columnsFor(width));

	/** Before the first row is measured only one row per column is drawn. */
	const plan = $derived.by(() => {
		if (row === null || boxHeight === 0) return null;
		if (single) {
			const only = lists[0] as Column;
			return { kind: 'single' as const, ...planSingle(only.items.length, cols, measures) };
		}
		const counts = lists.map((list) => list.items.length);
		return { kind: 'lists' as const, ...planLists(counts, { ...measures, head }, hidden) };
	});
	const footer = $derived.by(() => {
		if (!plan) return '';
		if (plan.kind === 'single') return plan.more > 0 ? t('page_more', { count: plan.more }) : '';
		return [
			plan.moreItems > 0 ? t('page_more', { count: plan.moreItems }) : '',
			plan.moreLists > 0 ? t('page_more_lists', { count: plan.moreLists }) : '',
		]
			.filter(Boolean)
			.join(' · ');
	});
	const countFor = (index: number) => (plan?.kind === 'lists' ? (plan.shown[index] ?? 0) : 1);
</script>

<svelte:window bind:innerWidth={width} />

<div class="relative size-full" bind:this={box} bind:clientHeight={boxHeight}>
	{#if drawn === null}
		{#if failed}
			<p class="bg-idle text-ink-soft rounded-lg px-5 py-4 text-xl">{t('page_unavailable')}</p>
		{/if}
	{:else if lists.length === 0}
		<p class="bg-idle text-ink-soft rounded-lg px-5 py-4 text-xl">{t('list_empty')}</p>
	{:else if single}
		{@const only = lists[0] as Column}
		{@const shownItems = plan?.kind === 'single' ? plan.shown : 1}
		{@const rows = plan?.kind === 'single' ? plan.rows : 1}
		<ul
			class="grid grid-flow-col gap-x-4"
			style:grid-template-columns="repeat({cols}, minmax(0, 1fr))"
			style:grid-template-rows="repeat({rows}, auto)"
			style:row-gap="{GAP}px"
			style:visibility={plan ? undefined : 'hidden'}
			aria-label={only.name}
		>
			{#each only.items.slice(0, shownItems) as item (item.id)}
				{@render itemRow(item)}
			{/each}
		</ul>
	{:else}
		<div
			class="grid gap-x-6"
			style:grid-template-columns="repeat({lists.length}, minmax(0, 1fr))"
			style:visibility={plan ? undefined : 'hidden'}
		>
			{#each lists as list, index (list.id)}
				<section class="min-w-0">
					<h2
						data-head
						class="type-dateline text-ink-soft mb-3 truncate font-extrabold tracking-wide uppercase"
					>
						{list.name}
					</h2>
					<ul class="grid" style:row-gap="{GAP}px">
						{#each list.items.slice(0, countFor(index)) as item (item.id)}
							{@render itemRow(item)}
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	{/if}
	<p
		bind:clientHeight={noteHeight}
		class="text-ink-soft absolute inset-x-0 bottom-0 px-1 text-lg font-semibold"
		class:invisible={!footer}
	>
		{footer || t('page_more', { count: 1 })}
	</p>
</div>

{#snippet itemRow(item: ShoppingItem)}
	<li
		data-row
		class="bg-surface shadow-lit flex min-w-0 items-center justify-between gap-4 rounded-xl px-5 py-3"
	>
		<b class="type-record truncate">{item.title}</b>
		{#if item.quantity}
			<span
				class="bg-idle text-ink-soft shrink-0 rounded-full px-3 py-1 text-lg leading-none font-semibold tabular-nums"
				>{item.quantity}</span
			>
		{/if}
	</li>
{/snippet}
