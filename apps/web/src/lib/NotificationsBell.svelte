<script lang="ts">
	import { goto } from '$app/navigation';
	import { isSameOriginPath } from '@famos/sdk/same-origin-path';
	import { Bell, Settings, X, Check } from '@lucide/svelte';
	import { tick } from 'svelte';
	import { ago } from '#lib/ago.js';
	import { t } from '#lib/i18n.svelte.js';
	import { notifications, type NotificationItem } from '#lib/notifications.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';

	/**
	 * The bell with the unread count.
	 *  - `mode="link"` (phones, in the head of Today): a 44 px link to `/notifications`.
	 *  - `mode="popover"` (sidebar and tablet rail): opens the list of recent notifications in a
	 *    popover, below the bell (`placement="below"`) or to its right (`"right"`, the rail).
	 * Renders nothing for people who cannot receive notifications.
	 */
	let {
		mode = 'link',
		placement = 'below',
		size = 36,
	}: { mode?: 'link' | 'popover'; placement?: 'below' | 'right'; size?: 36 | 44 } = $props();

	const LIMIT = 30;
	let open = $state(false);
	let trigger = $state<HTMLElement>();
	let panel = $state<HTMLElement>();
	let closeButton = $state<HTMLButtonElement>();
	let pos = $state({ top: 0, left: 0, maxHeight: 560 });

	const unread = $derived(notifications.unread);
	const label = $derived(
		unread > 0
			? `${t('nav_notifications')} · ${unread} ${t('notifications_unread')}`
			: t('nav_notifications'),
	);

	const startOfToday = () => {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	};
	const groups = $derived.by(() => {
		const from = startOfToday();
		const today = notifications.items.filter((i) => i.createdAt >= from);
		const earlier = notifications.items.filter((i) => i.createdAt < from);
		return [
			{ id: 'today', title: t('notifications_today'), items: today },
			{ id: 'earlier', title: t('notifications_earlier'), items: earlier },
		].filter((g) => g.items.length > 0);
	});

	function place() {
		if (!trigger) return;
		const rect = trigger.getBoundingClientRect();
		const top = placement === 'right' ? rect.top : rect.bottom + 8;
		const left = placement === 'right' ? rect.right + 12 : Math.max(12, rect.left);
		pos = { top, left, maxHeight: Math.min(560, window.innerHeight - top - 12) };
	}

	async function show() {
		place();
		open = true;
		void notifications.load(LIMIT);
		await tick();
		closeButton?.focus();
	}
	function close(restoreFocus = true) {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	$effect(() => {
		if (!open) return;
		return onEvent('core.notification.', () => void notifications.load(LIMIT));
	});

	function onkeydown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}
	function outside(e: PointerEvent) {
		const target = e.target as Node;
		if (open && !panel?.contains(target) && !trigger?.contains(target)) close(false);
	}

	async function choose(item: NotificationItem) {
		if (!item.read) await notifications.markRead([item.id], LIMIT);
		close(false);
		if (item.url && isSameOriginPath(item.url, window.location.origin)) await goto(item.url);
	}

	const box = $derived(size === 44 ? 'size-11' : 'size-9');
	const buttonClass = $derived(
		`focus-visible:ring-ring relative grid ${box} shrink-0 place-items-center rounded-xl outline-none focus-visible:ring-2 ` +
			(open ? 'bg-surface text-ink shadow-lit' : 'text-ink-soft hover:bg-idle hover:text-ink'),
	);
</script>

<svelte:window onpointerdown={outside} {onkeydown} onresize={() => open && place()} />

{#snippet face()}
	<Bell class="size-5" aria-hidden="true" />
	{#if unread > 0}
		<span
			data-testid="bell-count"
			class="bg-attention text-on-color ring-wall absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-bold tabular-nums ring-2"
			aria-hidden="true">{unread}</span
		>
	{/if}
{/snippet}

{#if session.can('core.notifications.receive')}
	{#if mode === 'link'}
		<a
			href="/notifications"
			data-testid="notifications-bell"
			aria-label={label}
			class={buttonClass}
		>
			{@render face()}
		</a>
	{:else}
		<button
			bind:this={trigger}
			type="button"
			data-testid="notifications-bell"
			aria-label={label}
			title={t('nav_notifications')}
			aria-haspopup="dialog"
			aria-expanded={open}
			class={buttonClass}
			onclick={() => (open ? close() : show())}
		>
			{@render face()}
		</button>

		{#if open}
			<div
				bind:this={panel}
				role="dialog"
				aria-label={t('nav_notifications')}
				data-testid="notifications-popover"
				style:top="{pos.top}px"
				style:left="{pos.left}px"
				style:max-height="{pos.maxHeight}px"
				class="bg-surface shadow-pop fixed z-50 flex w-[380px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border"
			>
				<header class="flex min-h-14 shrink-0 items-center gap-2 px-5 pt-2">
					<h2 class="text-[17px] font-extrabold">{t('nav_notifications')}</h2>
					{#if unread > 0}
						<span class="text-ink-soft text-sm font-semibold">
							{t('notifications_new', { count: unread })}
						</span>
					{/if}
					<button
						bind:this={closeButton}
						type="button"
						aria-label={t('notifications_close')}
						class="text-ink-soft hover:bg-idle hover:text-ink focus-visible:ring-ring ml-auto grid size-9 place-items-center rounded-xl outline-none focus-visible:ring-2"
						onclick={() => close()}
					>
						<X class="size-5" aria-hidden="true" />
					</button>
				</header>

				<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
					{#if groups.length === 0}
						<p class="text-ink-soft px-3 py-6 text-sm">{t('notifications_empty')}</p>
					{/if}
					{#each groups as group (group.id)}
						<h3
							class="text-ink-soft px-3 pt-3 pb-1 text-xs font-bold tracking-widest uppercase"
							id="notifications-group-{group.id}"
						>
							{group.title}
						</h3>
						<ul role="list" aria-labelledby="notifications-group-{group.id}" class="grid gap-0.5">
							{#each group.items as item (item.id)}
								<li>
									<button
										type="button"
										data-testid="notification-row"
										class="hover:bg-idle focus-visible:ring-ring flex min-h-14 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
										onclick={() => choose(item)}
									>
										<span
											class="mt-4 size-2 shrink-0 rounded-full {item.read
												? 'bg-transparent'
												: 'bg-info'}"
											aria-hidden="true"
										></span>
										<span
											class="bg-idle text-ink-soft grid size-9 shrink-0 place-items-center rounded-xl"
											aria-hidden="true"><Bell class="size-[18px]" /></span
										>
										<span class="grid min-w-0 flex-1 gap-0.5">
											<span class="text-sm {item.read ? 'font-semibold' : 'font-bold'}">
												{item.title}
												{#if !item.read}<span class="sr-only">
														· {t('notifications_unread')}</span
													>{/if}
											</span>
											{#if item.body}
												<span class="text-ink-soft line-clamp-2 text-[13px]">{item.body}</span>
											{/if}
										</span>
										<span class="text-ink-soft shrink-0 pt-0.5 text-[13px]"
											>{ago(item.createdAt)}</span
										>
									</button>
								</li>
							{/each}
						</ul>
					{/each}
					{#if notifications.items.length >= LIMIT}
						<a
							href="/notifications"
							onclick={() => close(false)}
							class="text-ink-soft hover:text-ink block px-3 py-3 text-sm font-semibold underline underline-offset-4"
							>{t('notifications_see_all')}</a
						>
					{/if}
				</div>

				<footer class="flex shrink-0 items-center justify-between border-t px-3 py-2">
					<button
						type="button"
						disabled={unread === 0}
						class="text-ink-soft hover:bg-idle hover:text-ink focus-visible:ring-ring flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm font-semibold outline-none focus-visible:ring-2 disabled:opacity-50"
						onclick={() => notifications.markRead(undefined, LIMIT)}
					>
						<Check class="size-4" aria-hidden="true" />{t('notifications_mark_all_short')}
					</button>
					<a
						href="/settings/notifications"
						onclick={() => close(false)}
						class="text-ink-soft hover:bg-idle hover:text-ink focus-visible:ring-ring flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm font-semibold outline-none focus-visible:ring-2"
					>
						<Settings class="size-4" aria-hidden="true" />{t('notifications_settings_short')}
					</a>
				</footer>
			</div>
		{/if}
	{/if}
{/if}
