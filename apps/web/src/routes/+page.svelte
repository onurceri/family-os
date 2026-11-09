<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { EmptyState, Page } from '@famos/ui/famos';
	import { useApp } from '@famos/ui/app';
	import Slot from '@famos/ui/slot';
	import { appearance } from '#lib/appearance.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import { withBlock } from '#lib/today/blocks.js';
	import { compositionFor } from '#lib/today/compositions.js';
	import { TodayData } from '#lib/today/today-data.svelte.js';

	/**
	 * Today: one data layer, `TodayData` (the day, the cards and their reports, chores,
	 * the photo, settling), and the composition of the style in use, which only arranges it. What
	 * it shows is the person's choice (or the family's): a hidden block is simply not there, and
	 * the `...` of a block's label hides it, with Undo. With everything hidden the page says so.
	 */
	const data = new TodayData(useApp(), {
		hidden: () => appearance.hidden,
		hiddenKnown: () => appearance.loaded,
		hide: (block) => void hide(block),
	});
	const Composition = $derived(compositionFor(appearance.previewingStyle ?? appearance.style));

	const save = (hidden: string[] | null) =>
		appearance.setMyHidden(hidden).catch(() => toasts.show(t('error_generic')));

	async function hide(block: string) {
		const before = appearance.myHidden;
		const name = data.blockName(block);
		try {
			await appearance.setMyHidden(withBlock(appearance.hidden, block, false));
		} catch {
			toasts.show(t('error_generic'));
			return;
		}
		toasts.show(t('block_hidden', { name }), {
			label: t('block_undo'),
			run: () => void save(before),
		});
	}
</script>

<Page template="day">
	{#if data.nothingShown}
		<!-- The phone's bell stays: Today is where it lives. -->
		<div class="flex justify-end empty:hidden md:hidden"><Slot name="today.head" /></div>
		<EmptyState title={t('nothing_shown_title')} hint={t('nothing_shown_hint')} art="generic">
			<Button href="/settings/appearance#today-blocks" variant="primary"
				>{t('nothing_shown_action')}</Button
			>
		</EmptyState>
	{:else}
		<!-- A container (`today`): the styles step down to a narrower arrangement when larger text
		     leaves too little room for their columns. -->
		<div class="@container/today"><Composition {data} /></div>
	{/if}
</Page>
