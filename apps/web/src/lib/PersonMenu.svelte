<script lang="ts">
	import { Bell, ChevronDown, LogOut, Palette, UserRound } from '@lucide/svelte';
	import { Avatar } from '@famos/ui/famos';
	import { tick } from 'svelte';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';

	/**
	 * The person at the foot of the sidebar and of the settings list, with a small menu: My
	 * account, Appearance, Notifications (preferences) and Sign out.
	 */
	let { onsignout }: { onsignout: () => void } = $props();

	const ROLES = ['admin', 'member', 'supervised', 'guest'];
	const role = $derived(
		session.me && ROLES.includes(session.me.roleId)
			? tDynamic(`app:role_${session.me.roleId}`)
			: null,
	);

	let menuOpen = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLElement>();

	const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

	async function open() {
		menuOpen = true;
		await tick();
		items()[0]?.focus();
	}
	function close(restoreFocus = true) {
		menuOpen = false;
		if (restoreFocus) trigger?.focus();
	}
	function onmenukeydown(e: KeyboardEvent) {
		const list = items();
		const i = list.indexOf(document.activeElement as HTMLElement);
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			list[(i + 1) % list.length]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			list[(i - 1 + list.length) % list.length]?.focus();
		} else if (e.key === 'Home') {
			e.preventDefault();
			list[0]?.focus();
		} else if (e.key === 'End') {
			e.preventDefault();
			list.at(-1)?.focus();
		} else if (e.key === 'Tab') {
			close(false);
		}
	}
	function outside(e: PointerEvent) {
		const target = e.target as Node;
		if (menuOpen && !menu?.contains(target) && !trigger?.contains(target)) close(false);
	}

	const itemClass =
		'group flex min-h-9 items-center gap-3 rounded-xl px-3 text-[0.9375rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ';
</script>

<svelte:window onpointerdown={outside} />

{#if session.me}
	<div class="relative">
		{#if menuOpen}
			<!-- svelte-ignore a11y_interactive_supports_focus -->
			<div
				bind:this={menu}
				role="menu"
				tabindex="-1"
				aria-label={session.me.displayName}
				onkeydown={onmenukeydown}
				class="bg-surface shadow-pop absolute inset-x-0 bottom-full mb-2 grid gap-0.5 rounded-xl border p-1.5"
			>
				<a
					role="menuitem"
					href="/settings/profile"
					class={itemClass + 'hover:bg-idle'}
					onclick={() => close(false)}
				>
					<UserRound class="text-ink-soft size-[18px]" aria-hidden="true" />{t('nav_profile')}
				</a>
				<a
					role="menuitem"
					href="/settings/appearance"
					class={itemClass + 'hover:bg-idle'}
					onclick={() => close(false)}
				>
					<Palette class="text-ink-soft size-[18px]" aria-hidden="true" />{t('nav_appearance')}
				</a>
				{#if session.can('core.notifications.receive')}
					<a
						role="menuitem"
						href="/settings/notifications"
						class={itemClass + 'hover:bg-idle'}
						onclick={() => close(false)}
					>
						<Bell class="text-ink-soft size-[18px]" aria-hidden="true" />{t('nav_notifications')}
					</a>
				{/if}
				<button
					type="button"
					role="menuitem"
					class={itemClass + 'text-destructive hover:bg-idle w-full text-left'}
					onclick={() => {
						close(false);
						onsignout();
					}}
				>
					<LogOut class="size-[18px]" aria-hidden="true" />{t('sign_out')}
				</button>
			</div>
		{/if}
		<button
			bind:this={trigger}
			type="button"
			aria-haspopup="menu"
			aria-expanded={menuOpen}
			onclick={() => (menuOpen ? close() : open())}
			class="hover:bg-idle focus-visible:ring-ring flex min-h-13 w-full items-center gap-3 rounded-xl px-3 text-left outline-none focus-visible:ring-2"
		>
			<Avatar name={session.me.displayName} color={session.me.color} size={36} />
			<span class="grid min-w-0 flex-1">
				<span class="truncate text-sm font-bold">{session.me.displayName}</span>
				{#if role}<span class="text-ink-soft truncate text-xs">{role}</span>{/if}
			</span>
			<ChevronDown class="text-ink-soft size-4 shrink-0" aria-hidden="true" />
		</button>
	</div>
{/if}
