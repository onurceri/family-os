<script lang="ts">
	import { isApiError, type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		fieldAria,
		FieldError,
		focusFirstInvalid,
		Notice,
		Page,
		PageHeader,
		Row,
		Section,
		SettingRow,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { api } from '#lib/api.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';

	type Status =
		paths['/api/v1/telegram/settings']['get']['responses'][200]['content']['application/json'];

	let status = $state<Status | null>(null);
	let token = $state('');
	let replacing = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	// The token's reason shows from the first refused Connect on, and goes once it is pasted.
	let tried = $state(false);
	const tokenError = $derived(tried && !token.trim() ? 'app:telegram_token_required' : undefined);

	async function load() {
		status = (await api.GET('/api/v1/telegram/settings')).data ?? null;
	}
	$effect(() => {
		if (!session.can('core.settings.manage')) return;
		void load();
		// The poller reports "Working" (or a problem) after the page opened.
		return onEvent('telegram.status.', () => void load());
	});

	async function save(next: string | null) {
		busy = true;
		error = null;
		try {
			status = unwrap(await api.PUT('/api/v1/telegram/token', { body: { token: next } }));
			token = '';
			replacing = false;
			toasts.show(t('telegram_saved'));
		} catch (e) {
			error =
				isApiError(e) && e.code === 'unavailable'
					? t('telegram_unreachable')
					: isApiError(e) && e.code === 'bad_request'
						? t('telegram_token_invalid')
						: t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function connect(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		if (!token.trim()) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		await save(token.trim());
		tried = false;
	}
</script>

<Page template="settings">
	<PageHeader title={t('telegram_title')} />

	<div class="grid gap-7">
		{#if error}<Notice tone="alert">{error}</Notice>{/if}
		<p class="text-ink-soft max-w-prose text-sm">{t('telegram_intro')}</p>

		{#if status?.configured}
			<Section label={t('telegram_title')}>
				<Card rows>
					<Row
						title={t('telegram_connected_as', { name: status.botUsername ?? '' })}
						meta={tDynamic(`app:telegram_state_${status.state}`)}
					>
						{#snippet trail()}
							<Button variant="outline" size="sm" onclick={() => (replacing = !replacing)}>
								{t('telegram_replace')}
							</Button>
							<ConfirmButton
								label={t('telegram_disconnect')}
								confirmLabel={t('telegram_disconnect_yes')}
								disabled={busy}
								onconfirm={() => save(null)}
							/>
						{/snippet}
					</Row>
				</Card>
				<p class="text-ink-soft max-w-prose text-[13px]">{t('telegram_needs_worker')}</p>
			</Section>
		{/if}

		{#if status && (!status.configured || replacing)}
			<Section label={t('telegram_steps_title')}>
				<details
					class="bg-surface group rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]"
					open={!status.configured}
				>
					<summary
						class="flex min-h-12 cursor-pointer list-none items-center gap-2 px-5 font-semibold [&::-webkit-details-marker]:hidden"
					>
						<span class="text-ink-soft transition-transform group-open:rotate-90" aria-hidden="true"
							>›</span
						>
						{t('telegram_how_title')}
					</summary>
					<div class="border-line border-t">
						<ol class="grid max-w-prose list-decimal gap-2 py-4 pr-5 pl-10 text-sm">
							<li>{t('telegram_step_1')}</li>
							<li>{t('telegram_step_2')}</li>
							<li>{t('telegram_step_3')}</li>
							<li>{t('telegram_step_4')}</li>
						</ol>
					</div>
				</details>
				<form onsubmit={connect} class="grid gap-4" novalidate>
					<Card rows>
						<SettingRow
							label={t('telegram_token_label')}
							for="telegram-token"
							hint={t('telegram_token_hint')}
						>
							{#snippet control()}
								<Input
									id="telegram-token"
									type="password"
									bind:value={token}
									autocomplete="off"
									spellcheck={false}
									required
									maxlength={200}
									{...fieldAria(tokenError, 'telegram-token')}
								/>
								<FieldError for="telegram-token" error={tokenError} />
							{/snippet}
						</SettingRow>
					</Card>
					<div>
						<Button type="submit" disabled={busy}>{t('telegram_connect')}</Button>
					</div>
				</form>
			</Section>
		{/if}

		<p class="text-ink-soft max-w-prose text-[13px]">{t('telegram_privacy')}</p>
	</div>
</Page>
