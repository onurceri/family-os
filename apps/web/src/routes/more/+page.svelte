<script lang="ts">
	import { goto } from '$app/navigation';
	import { Avatar, Page, PageHeader, Tile, wide } from '@famos/ui/famos';
	import { ChevronRight, LogOut } from '@lucide/svelte';
	import { signOut } from '#lib/auth.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { buildNav, type NavItem } from '#lib/nav.js';
	import SearchBox from '#lib/SearchBox.svelte';
	import { session } from '#lib/session.svelte.js';

	/**
	 * More. On a phone (and a tablet): the person, search, the Household pages as tiles, three
	 * doors into settings and Sign out. On a wide window there is no
	 * empty side: the first settings page opens, with the settings list on its left.
	 */
	const nav = $derived(
		buildNav((capability) => session.can(capability), session.disabledExtensions),
	);
	$effect(() => {
		if (!wide.current || session.status !== 'ready') return;
		const first = nav.settings[0]?.items[0]?.path ?? '/settings/profile';
		void goto(first, { replace: true });
	});

	const label = (item: NavItem) =>
		item.labelKey.includes(':') ? tDynamic(item.labelKey) : tDynamic(`app:${item.labelKey}`);

	const household = $derived(nav.moreGroups.flatMap((g) => (g.group === 'account' ? [] : g.items)));
	const doors = $derived(nav.settings.filter((s) => s.section !== 'you'));
	const summary = (items: NavItem[]) => items.map(label).join(', ');

	const ROLES = ['admin', 'member', 'supervised', 'guest'];
	const hint = $derived(
		session.me && ROLES.includes(session.me.roleId)
			? t('more_you_hint_role', { role: tDynamic(`app:role_${session.me.roleId}`) })
			: t('more_you_hint'),
	);

	async function logout() {
		await signOut();
		await session.refresh();
	}

	const card = 'bg-surface shadow-lit rounded-xl';
	const rowClass =
		'focus-visible:ring-ring flex min-h-13 w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset';
</script>

<Page template="settings">
	{#if !wide.current}
		<PageHeader title={t('nav_more')} />
		<div class="grid max-w-xl gap-6">
			{#if session.me}
				<a
					href="/more/you"
					data-testid="more-person"
					class="{card} focus-visible:ring-ring flex items-center gap-4 p-3 outline-none focus-visible:ring-2"
				>
					<Avatar name={session.me.displayName} color={session.me.color} size={48} />
					<span class="grid min-w-0 flex-1 gap-0.5">
						<span class="truncate text-[17px] font-bold">{session.me.displayName}</span>
						<span class="text-ink-soft text-sm">{hint}</span>
					</span>
					<ChevronRight class="text-ink-soft size-4 shrink-0" aria-hidden="true" />
				</a>
			{/if}

			<SearchBox />

			{#if household.length > 0}
				<section class="grid gap-2" aria-labelledby="more-household">
					<h2
						id="more-household"
						class="text-ink-soft px-1 text-xs font-bold tracking-wide uppercase"
					>
						{tDynamic('app:more_group_household')}
					</h2>
					<ul class="grid grid-cols-2 gap-2">
						{#each household as item (item.id)}
							<li class="min-w-0">
								<Tile href={item.path} title={label(item)} style="min-height: 56px">
									{#snippet lead()}
										<span class="bg-idle grid size-8 place-items-center rounded-full">
											{#if item.icon}<item.icon class="size-4" aria-hidden="true" />{/if}
										</span>
									{/snippet}
								</Tile>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if doors.length > 0}
				<section class="grid gap-2" aria-labelledby="more-settings">
					<h2
						id="more-settings"
						class="text-ink-soft px-1 text-xs font-bold tracking-wide uppercase"
					>
						{tDynamic('app:more_group_settings')}
					</h2>
					<ul class="{card} divide-y overflow-hidden">
						{#each doors as door (door.section)}
							<li>
								<!-- What a door holds wraps under its name: a phone is too narrow for one line. -->
								<a href="/more/{door.section}" class={rowClass}>
									<span class="grid min-w-0 flex-1 gap-0.5">
										<span class="text-[15px] font-semibold"
											>{tDynamic(`app:settings_section_${door.section}`)}</span
										>
										<span class="text-ink-soft text-[13px]">{summary(door.items)}</span>
									</span>
									<ChevronRight class="text-ink-soft size-4 shrink-0" aria-hidden="true" />
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<button type="button" class="{card} {rowClass}" onclick={logout}>
				<LogOut class="text-ink-soft size-[18px] shrink-0" aria-hidden="true" />
				<span class="flex-1 text-[15px] font-semibold">{t('sign_out')}</span>
				<ChevronRight class="text-ink-soft size-4 shrink-0" aria-hidden="true" />
			</button>
		</div>
	{/if}
</Page>
