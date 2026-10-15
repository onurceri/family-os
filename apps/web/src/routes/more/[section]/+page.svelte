<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Page, PageHeader, wide } from '@famos/ui/famos';
	import { SETTINGS_SECTIONS, type SettingsSection } from '@famos/ui/slots';
	import { ChevronRight } from '@lucide/svelte';
	import { tDynamic } from '#lib/i18n.svelte.js';
	import { buildNav, type NavItem } from '#lib/nav.js';
	import { session } from '#lib/session.svelte.js';

	/**
	 * One group of settings as a page of rows, for phones and tablets: More → Family → Members.
	 * On a wide window the group's first page opens instead.
	 */
	const nav = $derived(
		buildNav((capability) => session.can(capability), session.disabledExtensions),
	);
	const section = $derived(
		SETTINGS_SECTIONS.find((s) => s === page.params.section) as SettingsSection | undefined,
	);
	const items = $derived(nav.settings.find((s) => s.section === section)?.items ?? []);

	$effect(() => {
		if (session.status !== 'ready') return;
		if (!section || items.length === 0) void goto('/more', { replace: true });
		else if (wide.current) void goto(items[0]?.path ?? '/more', { replace: true });
	});

	const label = (item: NavItem) =>
		item.labelKey.includes(':') ? tDynamic(item.labelKey) : tDynamic(`app:${item.labelKey}`);
</script>

<Page template="settings">
	{#if section && !wide.current}
		<PageHeader title={tDynamic(`app:settings_section_${section}`)} />
		<ul class="bg-surface shadow-lit grid max-w-xl divide-y overflow-hidden rounded-xl">
			{#each items as item (item.id)}
				<li>
					<a
						href={item.path}
						class="focus-visible:ring-ring flex min-h-13 items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset"
					>
						{#if item.icon}<item.icon
								class="text-ink-soft size-[18px] shrink-0"
								aria-hidden="true"
							/>{/if}
						<span class="min-w-0 flex-1 truncate text-[15px] font-semibold">{label(item)}</span>
						<ChevronRight class="text-ink-soft size-4 shrink-0" aria-hidden="true" />
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</Page>
