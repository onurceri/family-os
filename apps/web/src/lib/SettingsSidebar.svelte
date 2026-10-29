<script lang="ts">
	import { goto } from '$app/navigation';
	import { ChevronLeft, Search } from '@lucide/svelte';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { type NavItem, type NavModel, settingsOwner } from '#lib/nav.js';
	import PersonMenu from '#lib/PersonMenu.svelte';
	import { settingsOrigin } from '#lib/settings-origin.svelte.js';
	import { filterSettings } from '#lib/settings-search.js';

	/**
	 * The settings list, on windows 1024 px wide and more: it
	 * replaces the app sidebar while a settings page is open. Back to FamilyOS, the title, a search
	 * that filters the rows (Enter opens the first match, "/" focuses it), the groups You, Family,
	 * AI and System, and the person at the foot.
	 */
	let {
		nav,
		current,
		onsignout,
	}: {
		nav: NavModel;
		/** The path of the open page. */
		current: string;
		onsignout: () => void;
	} = $props();

	const label = (item: NavItem) =>
		item.labelKey.includes(':') ? tDynamic(item.labelKey) : tDynamic(`app:${item.labelKey}`);
	/** Other words that find a row, from the catalog (`<label key>_words`); most extensions have none. */
	const words = (item: NavItem) => {
		const key = `${item.labelKey.includes(':') ? item.labelKey : `app:${item.labelKey}`}_words`;
		const found = tDynamic(key);
		return found === key ? '' : found;
	};
	const sectionTitle = (section: string) => tDynamic(`app:settings_section_${section}`);

	let query = $state('');
	let input = $state<HTMLInputElement>();

	const groups = $derived(filterSettings(nav.settings, query, label, words));
	const first = $derived(groups[0]?.items[0]);

	/** The row of the open page: the longest path that is the page or a parent of it. */
	const activeId = $derived(
		settingsOwner(
			nav.settings.flatMap((s) => s.items),
			current,
		)?.id,
	);

	// A row below the fold (the System group on a short window) scrolls into view when it opens.
	let listEl = $state<HTMLElement>();
	$effect(() => {
		void activeId;
		listEl?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
	});

	function onSearchKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && first) {
			e.preventDefault();
			void goto(first.path);
			query = '';
			input?.blur();
		} else if (e.key === 'Escape') {
			if (query) e.stopPropagation();
			query = '';
			input?.blur();
		}
	}
	// "/" jumps to the field when no input has focus.
	function onkeydown(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
		const el = document.activeElement as HTMLElement | null;
		if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
		if (!input || input.offsetParent === null) return;
		e.preventDefault();
		input.focus();
	}
</script>

<svelte:window {onkeydown} />

<nav
	aria-label={t('settings_title')}
	data-testid="settings-sidebar"
	class="bg-wall h-viewport sticky top-0 z-30 hidden w-62 flex-col border-r px-3 py-3 lg:flex"
>
	<div class="shrink-0">
		<a
			href={settingsOrigin.href}
			data-testid="settings-back"
			class="text-ink-soft hover:text-ink focus-visible:ring-ring flex min-h-9 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold outline-none focus-visible:ring-2"
		>
			<ChevronLeft class="size-4" aria-hidden="true" />{t('settings_back')}
		</a>
		<h2 class="mt-2 px-2 text-xl leading-tight font-extrabold tracking-tight">
			{t('settings_title')}
		</h2>
		<div
			class="bg-idle focus-within:ring-ring mt-3 flex min-h-10 items-center gap-2 rounded-xl px-3 focus-within:ring-2"
		>
			<Search class="text-ink-soft size-4 shrink-0" aria-hidden="true" />
			<input
				bind:this={input}
				bind:value={query}
				type="search"
				autocomplete="off"
				placeholder={t('settings_search')}
				aria-label={t('settings_search')}
				onkeydown={onSearchKey}
				class="placeholder:text-ink-soft min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
			/>
			{#if !query}
				<kbd
					class="text-ink-soft rounded-md border px-1.5 text-[11px] leading-5 font-bold"
					aria-hidden="true">/</kbd
				>
			{/if}
		</div>
	</div>

	<div bind:this={listEl} class="-mx-1 mt-3 min-h-0 flex-1 overflow-y-auto px-1">
		{#each groups as group (group.section)}
			<section class="mb-3 grid min-w-0" aria-labelledby="settings-group-{group.section}">
				<h3
					id="settings-group-{group.section}"
					class="text-ink-soft px-3 pt-1 pb-1 text-xs font-bold tracking-wide uppercase"
				>
					{sectionTitle(group.section)}
				</h3>
				{#each group.items as item (item.id)}
					{@const active = item.id === activeId}
					<a
						href={item.path}
						aria-current={active ? 'page' : undefined}
						class="focus-visible:ring-ring flex h-9 min-w-0 items-center gap-3 rounded-xl px-3 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset {active
							? 'bg-surface text-ink shadow-lit font-bold'
							: 'text-ink-soft hover:text-ink'}"
					>
						{#if item.icon}<item.icon class="size-[18px] shrink-0" aria-hidden="true" />{/if}
						<span class="truncate">{label(item)}</span>
					</a>
				{/each}
			</section>
		{:else}
			<p class="text-ink-soft px-3 text-sm" data-testid="settings-none">
				{t('settings_search_none')}
			</p>
		{/each}
	</div>

	<div class="mt-2 shrink-0 border-t pt-2">
		<PersonMenu {onsignout} />
	</div>
</nav>
