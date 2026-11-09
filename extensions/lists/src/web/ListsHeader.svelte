<script lang="ts">
	import { wide } from '@famos/ui/famos';
	import type { Snippet } from 'svelte';
	import { useLists } from './i18n.js';
	import { LIST_PAGES, type ListPage, listPagePath, rememberListPage } from './lists-page.js';

	/**
	 * The head of the Tasks and Shopping pages. On a wide window the sidebar has both pages, so the
	 * head is the title and its count. Narrower (one Lists tab), the title is a switch in type:
	 * "Tasks  Shopping", the open page large in `ink`, the other smaller in `ink-soft`; tapping it
	 * opens that page. The open page is remembered for the Lists tab.
	 */
	let { page, count, actions }: { page: ListPage; count: string; actions?: Snippet } = $props();
	const { t } = useLists();
	const titleOf = (p: ListPage) => t(p === 'tasks' ? 'tasks' : 'shopping');

	$effect(() => rememberListPage(page));
</script>

{#if wide.current}
	<header class="mb-6 flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2">
		<div class="flex min-w-0 items-baseline gap-3">
			<h1 class="type-page">{titleOf(page)}</h1>
			{#if count}<span
					class="text-ink-soft text-[1.0625rem] font-semibold"
					data-testid="lists-count">{count}</span
				>{/if}
		</div>
		{#if actions}<div class="ms-auto flex items-center gap-2">{@render actions()}</div>{/if}
	</header>
{:else}
	<header class="mb-5 flex flex-wrap items-end gap-x-3 gap-y-3">
		<div class="grid min-w-0 gap-0.5">
			<nav class="flex items-baseline gap-4" aria-label={t('nav')}>
				{#each LIST_PAGES as p (p)}
					{#if p === page}
						<h1 class="type-page">{titleOf(p)}</h1>
					{:else}
						<a
							href={listPagePath(p)}
							class="text-ink-soft hover:text-ink focus-visible:ring-ring -my-2 rounded-lg py-2 text-xl font-bold tracking-tight outline-none focus-visible:ring-2"
							>{titleOf(p)}</a
						>
					{/if}
				{/each}
			</nav>
			{#if count}<span
					class="text-ink-soft text-[0.9375rem] font-semibold"
					data-testid="lists-count">{count}</span
				>{/if}
		</div>
		{#if actions}<div class="ms-auto flex items-center gap-2">{@render actions()}</div>{/if}
	</header>
{/if}
