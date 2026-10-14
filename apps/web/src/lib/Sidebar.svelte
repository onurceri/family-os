<script lang="ts">
	import { ChevronDown, ChevronRight } from '@lucide/svelte';
	import Slot from '@famos/ui/slot';
	import { tick } from 'svelte';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import type { NavItem, NavModel } from '#lib/nav.js';
	import NotificationsBell from '#lib/NotificationsBell.svelte';
	import PersonMenu from '#lib/PersonMenu.svelte';

	/**
	 * Navigation on windows 1024 px wide and more: the head
	 * row (mark, bell, +), primary pages, the Household disclosure, More, and the person with a
	 * small menu. It never scrolls as a whole: Household closes itself first.
	 */
	let {
		nav,
		today,
		more,
		isActive,
		label,
		badge,
		onsignout,
	}: {
		nav: NavModel;
		today: NavItem;
		more: NavItem;
		isActive: (item: NavItem) => boolean;
		label: (item: NavItem) => string;
		badge: (item: NavItem) => number | undefined;
		onsignout: () => void;
	} = $props();

	/** Keys shown on hover, per page (the shortcuts live in the layout). */
	const keysFor = (item: NavItem): string[] | undefined =>
		item.path === '/'
			? ['g', 't']
			: item.shortcut
				? ['g', item.shortcut]
				: item.share
					? ['n']
					: undefined;

	// Household is a disclosure. It closes itself when the sidebar would otherwise scroll; a
	// person's own choice is remembered on this device and wins over that.
	const STORE = 'famos.sidebar.household';
	function stored(): boolean | null {
		try {
			const v = localStorage.getItem(STORE);
			return v === 'open' ? true : v === 'closed' ? false : null;
		} catch {
			return null;
		}
	}
	let userChoice = $state<boolean | null>(stored());
	let collapsed = $state(false);
	let region = $state<HTMLElement>();
	let primaryEl = $state<HTMLElement>();
	let headEl = $state<HTMLElement>();
	let listEl = $state<HTMLElement>();
	let fullHeight = 0;

	const householdCount = $derived(nav.household.reduce((n, g) => n + g.items.length, 0));
	const hasActive = $derived(nav.household.some((g) => g.items.some((i) => isActive(i))));
	const expanded = $derived(hasActive || (userChoice ?? !collapsed));

	function toggleHousehold() {
		const next = !expanded;
		userChoice = next;
		try {
			localStorage.setItem(STORE, next ? 'open' : 'closed');
		} catch {
			// remembered only for this visit
		}
	}

	function measure() {
		if (!region || !primaryEl || !headEl) return;
		if (expanded)
			fullHeight = primaryEl.offsetHeight + headEl.offsetHeight + 12 + (listEl?.scrollHeight ?? 0);
		if (userChoice !== null || hasActive) return;
		const available = region.clientHeight;
		if (!collapsed && fullHeight > available) collapsed = true;
		else if (collapsed && fullHeight > 0 && fullHeight <= available) collapsed = false;
	}
	$effect(() => {
		if (!region) return;
		const observer = new ResizeObserver(measure);
		observer.observe(region);
		if (primaryEl) observer.observe(primaryEl);
		return () => observer.disconnect();
	});
	$effect(() => {
		void nav.household;
		void expanded;
		void tick().then(measure);
	});

	// A primary entry with pages under it (Lists: Tasks, Shopping) is a group that folds. It is
	// open unless the person closed it; that choice is remembered on this device.
	const groupKey = (item: NavItem) => `famos.sidebar.group.${item.id}`;
	function storedGroup(item: NavItem): boolean {
		try {
			return localStorage.getItem(groupKey(item)) !== 'closed';
		} catch {
			return true;
		}
	}
	let groupOpen = $state<Record<string, boolean>>({});
	const isGroupOpen = (item: NavItem) => groupOpen[item.id] ?? storedGroup(item);
	function toggleGroup(item: NavItem) {
		const next = !isGroupOpen(item);
		groupOpen[item.id] = next;
		try {
			localStorage.setItem(groupKey(item), next ? 'open' : 'closed');
		} catch {
			// remembered only for this visit
		}
	}

	const itemClass =
		'group flex min-h-9 items-center gap-3 rounded-xl px-3 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ';
	const linkClass = (active: boolean) =>
		itemClass +
		(active ? 'bg-surface text-ink shadow-lit font-bold' : 'text-ink-soft hover:text-ink');
</script>

{#snippet group(item: NavItem, children: NavItem[])}
	{@const open = isGroupOpen(item)}
	{@const inside = children.some((child) => isActive(child))}
	<div class="grid gap-0.5" role="group" aria-labelledby="nav-group-{item.id}">
		<button
			type="button"
			id="nav-group-{item.id}"
			aria-expanded={open}
			aria-controls="nav-group-list-{item.id}"
			data-testid="nav-group"
			onclick={() => toggleGroup(item)}
			class={linkClass(!open && inside)}
		>
			{#if item.icon}<item.icon class="size-[18px] shrink-0" aria-hidden="true" />{/if}
			<span class="truncate">{label(item)}</span>
			<span class="flex-1"></span>
			{#if open}
				<ChevronDown class="size-4 shrink-0" aria-hidden="true" />
			{:else}
				<ChevronRight class="size-4 shrink-0" aria-hidden="true" />
			{/if}
		</button>
		{#if open}
			<div id="nav-group-list-{item.id}" class="grid gap-0.5 ps-4">
				{#each children as child (child.id)}{@render link(child)}{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet link(item: NavItem)}
	{@const active = isActive(item)}
	{@const count = badge(item)}
	{@const keys = keysFor(item)}
	<a href={item.path} aria-current={active ? 'page' : undefined} class={linkClass(active)}>
		{#if item.icon}<item.icon class="size-[18px] shrink-0" aria-hidden="true" />{/if}
		<span class="truncate">{label(item)}</span>
		<span class="flex-1"></span>
		{#if keys}
			<span
				class="invisible flex shrink-0 gap-1 group-hover:visible group-focus-visible:visible"
				aria-hidden="true"
				data-testid="keycap"
			>
				{#each keys as key (key)}
					<kbd
						class="text-ink-soft rounded-md border px-1.5 text-[11px] leading-5 font-bold uppercase"
						>{key}</kbd
					>
				{/each}
			</span>
		{/if}
		{#if count}
			<span
				class="bg-attention text-on-color min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs leading-5 font-bold tabular-nums"
				>{count}<span class="sr-only"> · {t('nav_waiting')}</span></span
			>
		{/if}
	</a>
{/snippet}

<nav
	aria-label={t('nav_label')}
	data-testid="sidebar"
	class="bg-wall sticky top-0 z-30 hidden h-dvh w-62 flex-col border-r px-3 py-3 lg:flex"
>
	<!-- Head: the mark on the left, the bell and Quick add's + on the right. -->
	<div class="mb-2 flex min-h-11 shrink-0 items-center gap-1">
		<a
			href="/"
			class="focus-visible:ring-ring flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 text-lg font-extrabold tracking-tight outline-none focus-visible:ring-2"
		>
			<img src="/favicon.svg" alt="" class="size-[30px] shrink-0" />
			<span class="truncate">{t('app_name')}</span>
		</a>
		<NotificationsBell mode="popover" placement="below" size={36} />
		<Slot name="nav.action" props={{ variant: 'sidebar' }} />
	</div>

	<!-- Only Household's list ever scrolls; the sidebar as a whole does not. -->
	<div bind:this={region} class="-mx-1 flex min-h-0 flex-1 flex-col overflow-hidden px-1">
		<div bind:this={primaryEl} class="grid shrink-0 content-start gap-0.5">
			{@render link(today)}
			{#each nav.primary as item (item.id)}
				{#if item.children?.length}{@render group(item, item.children)}{:else}{@render link(
						item,
					)}{/if}
			{/each}
		</div>

		{#if householdCount > 0}
			<section class="mt-3 flex min-h-0 flex-col" aria-label={tDynamic('app:more_group_household')}>
				<button
					bind:this={headEl}
					type="button"
					aria-expanded={expanded}
					aria-controls="sidebar-household"
					data-testid="household-toggle"
					onclick={toggleHousehold}
					class="text-ink-soft hover:text-ink focus-visible:ring-ring flex min-h-7 shrink-0 items-center gap-1 rounded-lg px-3 text-xs font-bold tracking-wide uppercase outline-none focus-visible:ring-2 focus-visible:ring-inset"
				>
					<span>{tDynamic('app:more_group_household')}</span>
					{#if !expanded}
						<span class="font-semibold tracking-normal normal-case"
							>· {t('nav_household_pages', { count: householdCount })}</span
						>
					{/if}
					<span class="flex-1"></span>
					{#if expanded}
						<ChevronDown class="size-4" aria-hidden="true" />
					{:else}
						<ChevronRight class="size-4" aria-hidden="true" />
					{/if}
				</button>
				{#if expanded}
					<div
						bind:this={listEl}
						id="sidebar-household"
						class="grid min-h-0 content-start gap-0.5 overflow-y-auto"
					>
						{#each nav.household as { group, items: groupItems } (group)}
							{#each groupItems as item (item.id)}{@render link(item)}{/each}
						{/each}
					</div>
				{/if}
			</section>
		{/if}
	</div>

	<div class="mt-2 grid shrink-0 gap-0.5 border-t pt-2">
		{@render link(more)}
		<PersonMenu {onsignout} />
	</div>
</nav>
