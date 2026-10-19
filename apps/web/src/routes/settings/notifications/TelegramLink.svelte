<script lang="ts">
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Card, Section } from '@famos/ui/famos';
	import { untrack } from 'svelte';
	import { api } from '#lib/api.js';
	import { getLocale, t } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';

	type Link =
		paths['/api/v1/telegram/link']['get']['responses'][200]['content']['application/json'];
	type Code =
		paths['/api/v1/telegram/link']['post']['responses'][200]['content']['application/json'];

	/** Linking one's Telegram account; shown once an admin has connected a bot. */
	let { onchanged }: { onchanged: () => void } = $props();

	let link = $state<Link | null>(null);
	let code = $state<Code | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function load() {
		// Read without tracking: load() runs inside an effect, and tracking `link` here made every
		// answer start the next request (an endless loop of GET /telegram/link).
		const was = untrack(() => link?.linked ?? false);
		link = (await api.GET('/api/v1/telegram/link')).data ?? null;
		if (link?.linked) code = null;
		// Telegram is a new channel for this person: its switches appear in the preferences.
		if (link && link.linked !== was) onchanged();
	}

	$effect(() => {
		if (session.status !== 'ready') return;
		void load();
		// Linked or unlinked from the chat, or the bot was connected or removed.
		const offLink = onEvent('telegram.link.', (_name, payload) => {
			const who = (payload as { memberId?: string } | undefined)?.memberId;
			if (!who || who === session.me?.id) void load();
		});
		const offStatus = onEvent('telegram.status.', () => void load());
		return () => {
			offLink();
			offStatus();
		};
	});

	// While a code is waiting, notice when the bot has linked the account.
	$effect(() => {
		if (!code) return;
		const timer = setInterval(() => void load(), 3000);
		return () => clearInterval(timer);
	});

	async function createCode() {
		busy = true;
		error = null;
		try {
			code = unwrap(await api.POST('/api/v1/telegram/link'));
		} catch {
			error = t('telegram_link_failed');
		} finally {
			busy = false;
		}
	}

	async function unlink() {
		busy = true;
		error = null;
		try {
			await api.DELETE('/api/v1/telegram/link');
			code = null;
			await load();
		} finally {
			busy = false;
		}
	}

	const until = (ms: number) => dateTimeFormat({ timeStyle: 'short' }).format(ms);
</script>

{#if link?.available}
	<Section label={t('telegram_link_title')}>
		<Card rows>
			<div class="grid gap-3 px-4 py-3">
				{#if link.linked}
					<p class="font-medium">
						{t('telegram_link_status', { who: link.username ? ` · @${link.username}` : '' })}
					</p>
					<div>
						<Button variant="outline" disabled={busy} onclick={unlink}
							>{t('telegram_unlink')}</Button
						>
					</div>
				{:else if code}
					<p class="text-ink-soft text-sm">{t('telegram_link_code')}</p>
					<p class="font-mono text-2xl font-bold tracking-widest" data-testid="telegram-code">
						{code.code}
					</p>
					<div>
						<Button href={code.url} target="_blank" rel="noopener noreferrer">
							{t('telegram_link_open')}
						</Button>
					</div>
					<p class="text-ink-soft text-sm">{t('telegram_link_steps', { code: code.code })}</p>
					<small class="text-ink-soft text-xs">
						{t('telegram_link_expires', { time: until(code.expiresAt) })}
					</small>
				{:else}
					<p class="text-ink-soft text-sm">{t('telegram_link_hint')}</p>
					<div>
						{#if session.me?.fullSignIn}
							<Button disabled={busy} onclick={createCode}>{t('telegram_link_button')}</Button>
						{:else}
							<p class="text-ink-soft text-sm" data-testid="telegram-password-needed">
								{t('sign_in_password_for_keys')}
							</p>
						{/if}
					</div>
				{/if}
				<p class="text-ink-soft text-xs">{t('telegram_link_privacy')}</p>
				{#if error}<p class="text-sm font-semibold" role="alert">{error}</p>{/if}
			</div>
		</Card>
	</Section>
{/if}
