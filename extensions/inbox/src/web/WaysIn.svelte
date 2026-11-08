<script lang="ts">
	import { Section } from '@famos/ui/famos';
	import { Mail, Send, Smartphone } from '@lucide/svelte';
	import { loadWays, type Ways } from './data.js';
	import { useInbox } from './i18n.js';
	import { type WayStatus, wayStatus } from './ways.js';

	/**
	 * "Other ways in" under the capture box: the phone's share sheet, Telegram and email, each a
	 * quiet tile with one line. A way that is not set up says so, with a "Set up" link for the
	 * people who may set it up.
	 */
	const { app, t } = useInbox();

	let ways = $state<Ways | null>(null);
	$effect(() => {
		let live = true;
		void loadWays().then((w) => {
			if (live) ways = w;
		});
		return () => {
			live = false;
		};
	});

	const canManage = $derived(app.can('core.settings.manage'));
	const telegram = $derived(
		wayStatus(ways?.telegram?.available, canManage, ways?.telegram?.linked ?? true),
	);
	const email = $derived(wayStatus(ways?.email, canManage));

	type Tile = {
		id: string;
		icon: typeof Smartphone;
		name: string;
		line: string;
		status: WayStatus;
		setUp?: string;
	};
	const tiles = $derived<Tile[]>([
		{
			id: 'phone',
			icon: Smartphone,
			name: t('way_phone_title'),
			line: t('way_phone_line'),
			status: 'ready',
		},
		{
			id: 'telegram',
			icon: Send,
			name: t('channel_telegram'),
			line:
				telegram === 'ready' && ways?.telegram?.bot
					? t('way_telegram_bot', { bot: ways.telegram.bot })
					: t('way_telegram_line'),
			status: telegram,
			setUp: telegram === 'link' ? '/settings/notifications' : '/settings/telegram',
		},
		{
			id: 'email',
			icon: Mail,
			name: t('way_email_title'),
			line: t('way_email_line'),
			status: email,
			setUp: '/settings/email',
		},
	]);
</script>

<Section label={t('ways_title')}>
	<ul class="grid gap-x-6 gap-y-4 sm:grid-cols-3" data-testid="quick-add-ways">
		{#each tiles as tile (tile.id)}
			<li class="flex min-w-0 items-start gap-3" data-way={tile.id}>
				<span class="bg-idle text-ink-soft grid size-9 shrink-0 place-items-center rounded-full">
					<tile.icon class="size-[18px]" aria-hidden="true" />
				</span>
				<div class="grid min-w-0 gap-0.5 text-[0.8125rem] leading-snug">
					<b class="text-[0.875rem] font-bold">{tile.name}</b>
					<span class="text-ink-soft text-pretty">{tile.line}</span>
					{#if tile.status === 'setup' || tile.status === 'link'}
						<a
							href={tile.setUp}
							class="text-ink justify-self-start font-semibold underline underline-offset-4"
							>{tile.status === 'link' ? t('way_link') : t('way_set_up')}</a
						>
					{:else if tile.status === 'waiting'}
						<span class="text-ink-soft italic">{t('way_not_set_up')}</span>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
</Section>
