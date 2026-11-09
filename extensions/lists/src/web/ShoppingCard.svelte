<script lang="ts">
	import { BigNumber, TodaySection } from '@famos/ui/famos';
	import type { SlotProps } from '@famos/ui/slots';
	import type { ShoppingList } from '../contract/index.js';
	import { loadItems, loadLists } from './data.js';
	import { useLists } from './i18n.js';

	/**
	 * Today, notes band: the first shopping list as chips of what is still to buy; at a glance
	 * (`form: 'glance'`), how many things are to get as a big number with the first few named.
	 */
	let { size, report, form = 'rows' }: SlotProps['dashboard.card'] = $props();
	const { app, t } = useLists();
	let list = $state<ShoppingList | null>(null);
	let titles = $state<string[]>([]);
	let loaded = $state(false);

	async function load() {
		try {
			list = (await loadLists())[0] ?? null;
			titles = list
				? (await loadItems(list.id)).filter((i) => i.doneAt === null).map((i) => i.title)
				: [];
		} catch {
			list = null;
			titles = [];
		} finally {
			loaded = true;
		}
	}
	$effect(() => {
		void load();
		return app.onEvent('lists.shopping.', () => void load());
	});

	const limit = $derived(size === 'wide' ? 10 : 6);
	// A family display only looks: no link there (it has no app pages).
	const listHref = $derived(app.isAppPath('/lists/shopping') ? '/lists/shopping' : undefined);
	const NAMED = 3;
	const detail = $derived(
		[
			titles.slice(0, NAMED).join(', '),
			titles.length > NAMED ? t('today_more', { count: titles.length - NAMED }) : '',
		]
			.filter(Boolean)
			.join(' '),
	);
	// Reports only once loaded: the page keeps the last report while a card moves between columns.
	$effect(() => {
		if (loaded) report({ count: titles.length, quietKey: 'lists:quiet_shopping' });
	});
</script>

{#if size !== 'line' && list && form === 'glance'}
	<TodaySection
		title={t('shopping')}
		count={list.name || t('default_list')}
		href={listHref}
		more={t('today_open_list')}
	>
		<BigNumber
			value={titles.length}
			formatLocale={app.formatLocale()}
			title={t('today_to_get', { count: titles.length })}
			{detail}
		/>
	</TodaySection>
{:else if size !== 'line' && list}
	<TodaySection
		title={t('shopping')}
		count={`${list.name || t('default_list')} · ${titles.length}`}
		href={listHref}
		more={t('today_open_list')}
	>
		<ul class="flex flex-wrap gap-2" aria-label={t('shopping')}>
			{#each titles.slice(0, limit) as title, i (`${i}:${title}`)}
				<li class="bg-idle min-h-8 rounded-full px-3.5 py-1 text-[0.9375rem] font-semibold">
					{title}
				</li>
			{/each}
			{#if titles.length > limit}
				<li class="text-ink-soft flex min-h-8 items-center px-1 text-sm font-semibold">
					{t('today_more', { count: titles.length - limit })}
				</li>
			{/if}
		</ul>
	</TodaySection>
{/if}
