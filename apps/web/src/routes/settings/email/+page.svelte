<script lang="ts">
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { isApiError, type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		Notice,
		Page,
		PageHeader,
		Pill,
		Row,
		Section,
		SettingRow,
		SidePanel,
		SwitchRow,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { api } from '#lib/api.js';
	import { family } from '#lib/family.svelte.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import { Plus } from '@lucide/svelte';

	type Settings =
		paths['/api/v1/email/settings']['get']['responses'][200]['content']['application/json'];
	type Sender =
		paths['/api/v1/email/senders']['get']['responses'][200]['content']['application/json'][number];

	let settings = $state<Settings | null>(null);
	let senders = $state<Sender[]>([]);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let checking = $state(false);

	// The form. The password is never loaded back: empty means "keep the saved one".
	let host = $state('');
	let port = $state(993);
	let username = $state('');
	let password = $state('');
	let mailbox = $state('INBOX');
	let processedFolder = $state('FamilyOS');
	let pollMinutes = $state(5);
	let enabled = $state(true);
	let formLoaded = false;

	let newAddress = $state('');
	let newMember = $state('');
	let newLabel = $state('');

	async function load() {
		const [s, list] = await Promise.all([
			api.GET('/api/v1/email/settings'),
			api.GET('/api/v1/email/senders'),
		]);
		settings = s.data ?? null;
		senders = list.data ?? [];
		if (settings && !formLoaded) {
			formLoaded = true;
			if (settings.configured) {
				({ host, port, username, mailbox, processedFolder, pollMinutes, enabled } = settings);
			}
		}
		if (checking && settings?.checkedAt !== checkedBefore) checking = false;
	}
	let checkedBefore: number | null = null;

	$effect(() => {
		if (!session.can('core.settings.manage')) return;
		void load();
		// The members (allowed senders) come from the shell, which keeps them current.
		// The worker reports the result of a check after the page opened.
		return onEvent('core.email.status.', () => void load());
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			const result = unwrap(
				await api.PUT('/api/v1/email/settings', {
					body: {
						host,
						port,
						username,
						...(password && { password }),
						mailbox,
						processedFolder,
						pollMinutes,
						enabled,
					},
				}),
			);
			settings = result.settings;
			password = '';
			if (result.test.ok) toasts.show(t('email_saved'));
			else error = t('email_not_saved', { reason: tDynamic(`app:email_test_${result.test.code}`) });
		} catch (e) {
			error =
				isApiError(e) && e.code === 'bad_request' ? t('email_sender_invalid') : t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function disconnect() {
		busy = true;
		try {
			unwrap(await api.POST('/api/v1/actions/core.disconnectEmail', { body: {} }));
			formLoaded = false;
			host = username = password = '';
			port = 993;
			await load();
		} finally {
			busy = false;
		}
	}

	async function checkNow() {
		checking = true;
		checkedBefore = settings?.checkedAt ?? null;
		try {
			unwrap(await api.POST('/api/v1/actions/core.checkEmailNow', { body: {} }));
		} catch {
			checking = false;
			error = t('error_generic');
			return;
		}
		// The worker answers through a realtime event; do not wait forever if it is not running.
		setTimeout(() => {
			if (checking) {
				checking = false;
				void load();
			}
		}, 20_000);
	}

	// The sender panel lives in the address (?new=1).
	const here = $derived(page.url.pathname);
	const addingSender = $derived(page.url.searchParams.has('new'));
	const closePanel = () => void goto(here, { replace: true, reset: false });
	let senderForm = $state<HTMLFormElement>();

	async function addSender() {
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.addEmailSender', {
					body: {
						address: newAddress,
						memberId: newMember,
						...(newLabel.trim() && { label: newLabel.trim() }),
					},
				}),
			);
			newAddress = newLabel = '';
			closePanel();
			await load();
		} catch (e) {
			error =
				isApiError(e) && e.code === 'bad_request' ? t('email_sender_invalid') : t('error_generic');
		}
	}

	async function removeSender(address: string) {
		unwrap(await api.POST('/api/v1/actions/core.removeEmailSender', { body: { address } }));
		await load();
	}

	const memberName = (id: string) => family.members.find((m) => m.id === id)?.displayName ?? '';
	const checkedAt = $derived(
		settings?.checkedAt
			? dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(settings.checkedAt)
			: null,
	);
</script>

<Page template="settings">
	<PageHeader title={t('email_title')} />

	<div class="grid gap-7">
		{#if error}<Notice tone="alert">{error}</Notice>{/if}

		<!-- The steps matter once; after that they stay folded away. -->
		{#if settings}
			<details
				class="bg-surface group rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]"
				open={!settings.configured}
			>
				<summary
					class="flex min-h-12 cursor-pointer list-none items-center gap-2 px-5 font-semibold [&::-webkit-details-marker]:hidden"
				>
					<span class="text-ink-soft transition-transform group-open:rotate-90" aria-hidden="true"
						>›</span
					>
					{t('email_how_title')}
				</summary>
				<div class="border-line grid gap-3 border-t px-5 pt-3 pb-4">
					<p class="text-ink-soft max-w-prose text-sm">{t('email_intro')}</p>
					<ol class="grid max-w-prose list-decimal gap-2 pl-5 text-sm">
						<li>{t('email_how_1')}</li>
						<li>{t('email_how_2')}</li>
						<li>{t('email_how_3')}</li>
						<li>{t('email_how_4')}</li>
					</ol>
					<p class="text-ink-soft max-w-prose text-sm">{t('email_oauth_note')}</p>
				</div>
			</details>
		{/if}

		{#if settings}
			<Section label={t('email_server_title')}>
				<form onsubmit={save} class="grid gap-4">
					<Card rows>
						<SettingRow label={t('email_host')} for="email-host">
							{#snippet control()}
								<Input
									id="email-host"
									bind:value={host}
									required
									maxlength={253}
									autocomplete="off"
									spellcheck={false}
									placeholder="imap.example.com"
								/>
							{/snippet}
						</SettingRow>
						<SettingRow
							label={t('email_port')}
							for="email-port"
							help={t('email_port_hint')}
							helpLabel={t('help')}
						>
							{#snippet control()}
								<Input
									id="email-port"
									type="number"
									bind:value={port}
									required
									min={1}
									max={65535}
									class="w-28"
								/>
							{/snippet}
						</SettingRow>
						<SettingRow label={t('email_username')} for="email-username">
							{#snippet control()}
								<Input
									id="email-username"
									bind:value={username}
									required
									maxlength={320}
									autocomplete="off"
									spellcheck={false}
								/>
							{/snippet}
						</SettingRow>
						<SettingRow
							label={t('email_password')}
							for="email-password"
							hint={settings.configured
								? t('email_password_hint_keep')
								: t('email_password_hint_new')}
						>
							{#snippet control()}
								<Input
									id="email-password"
									type="password"
									bind:value={password}
									required={!settings?.configured}
									maxlength={500}
									autocomplete="new-password"
								/>
							{/snippet}
						</SettingRow>
						<SettingRow label={t('email_mailbox')} for="email-mailbox">
							{#snippet control()}
								<Input id="email-mailbox" bind:value={mailbox} required maxlength={200} />
							{/snippet}
						</SettingRow>
						<SettingRow
							label={t('email_folder')}
							for="email-folder"
							help={t('email_folder_hint')}
							helpLabel={t('help')}
						>
							{#snippet control()}
								<Input id="email-folder" bind:value={processedFolder} required maxlength={200} />
							{/snippet}
						</SettingRow>
						<SettingRow label={t('email_poll')} for="email-poll">
							{#snippet control()}
								<Input
									id="email-poll"
									type="number"
									bind:value={pollMinutes}
									required
									min={2}
									max={1440}
									class="w-28"
								/>
							{/snippet}
						</SettingRow>
						<SwitchRow id="email-enabled" label={t('email_enabled')} bind:checked={enabled} />
					</Card>
					<div class="flex flex-wrap items-center gap-2">
						<Button type="submit" disabled={busy}>{t('email_save')}</Button>
						{#if settings.configured}
							<ConfirmButton
								label={t('email_disconnect')}
								confirmLabel={t('email_disconnect_yes')}
								disabled={busy}
								onconfirm={disconnect}
							/>
						{/if}
					</div>
				</form>
			</Section>
		{/if}

		{#if settings?.configured}
			<Section label={t('email_status_title')}>
				<Card rows>
					<Row
						title={settings.state === 'ok' ||
						settings.state === 'off' ||
						settings.state === 'pending'
							? tDynamic(`app:email_state_${settings.state}`)
							: tDynamic(`app:email_test_${settings.state}`)}
						meta={checkedAt ? t('email_checked', { time: checkedAt }) : t('email_never_checked')}
					>
						{#snippet trail()}
							<Button
								variant="outline"
								size="sm"
								disabled={checking || !settings?.enabled}
								onclick={checkNow}
								data-testid="email-check-now"
							>
								{checking ? t('email_checking') : t('email_check_now')}
							</Button>
						{/snippet}
					</Row>
					<Row title={t('email_processed', { count: settings.processed })} />
					{#if settings.unknownSenders > 0}
						<Row title={t('email_unknown', { count: settings.unknownSenders })} />
					{/if}
					{#if settings.refused > 0}
						<Row title={t('email_refused', { count: settings.refused })} />
					{/if}
					{#if settings.failed > 0}
						<Row title={t('email_failed', { count: settings.failed })}>
							{#snippet trail()}<Pill tone="attention">{t('email_failed_pill')}</Pill>{/snippet}
						</Row>
					{/if}
				</Card>
				<p class="text-ink-soft text-[13px]">{t('email_needs_worker')}</p>
			</Section>
		{/if}

		<Section label={t('email_senders_title')} count={senders.length || undefined}>
			{#snippet actions()}
				<Button variant="ghost" onclick={() => goto(`${here}?new=1`, { reset: false })}
					><Plus />{t('email_sender_add')}</Button
				>
			{/snippet}
			<p class="text-ink-soft max-w-prose text-sm">{t('email_senders_intro')}</p>
			{#if senders.length > 0}
				<Card rows data-testid="email-senders">
					{#each senders as sender (sender.address)}
						<Row
							title={sender.address}
							meta={`${t('email_sender_for', { name: memberName(sender.memberId) })}${sender.label ? ` · ${sender.label}` : ''}`}
						>
							{#snippet trail()}
								<ConfirmButton
									label={t('email_sender_remove')}
									confirmLabel={t('email_sender_remove_yes')}
									onconfirm={() => removeSender(sender.address)}
								/>
							{/snippet}
						</Row>
					{/each}
				</Card>
			{:else}
				<Notice>{t('email_senders_empty')}</Notice>
			{/if}
		</Section>

		<p class="text-ink-soft max-w-prose text-[13px]">{t('email_privacy')}</p>
	</div>

	<SidePanel
		open={addingSender}
		title={t('email_sender_add')}
		onclose={closePanel}
		closeLabel={t('side_panel_close')}
		cancelLabel={t('cancel')}
		saveLabel={t('email_sender_add')}
		saveDisabled={!newAddress.trim() || !newMember}
		onsave={() => senderForm?.requestSubmit()}
	>
		<form
			bind:this={senderForm}
			onsubmit={(e) => {
				e.preventDefault();
				void addSender();
			}}
			class="grid gap-4"
		>
			<div class="grid gap-1.5">
				<Label for="sender-address">{t('email_sender_address')}</Label>
				<Input
					id="sender-address"
					type="email"
					bind:value={newAddress}
					required
					maxlength={320}
					autocomplete="off"
				/>
			</div>
			<div class="grid gap-1.5">
				<Label for="sender-member">{t('email_sender_member')}</Label>
				<select
					id="sender-member"
					class="border-input bg-wall min-h-[var(--ctl)] rounded-[var(--r-ctl)] border px-3 text-[15px]"
					bind:value={newMember}
					required
				>
					<option value="" disabled></option>
					{#each family.members as member (member.id)}
						<option value={member.id}>{member.displayName}</option>
					{/each}
				</select>
			</div>
			<div class="grid gap-1.5">
				<Label for="sender-label">{t('email_sender_label')}</Label>
				<Input id="sender-label" bind:value={newLabel} maxlength={100} />
			</div>
		</form>
	</SidePanel>
</Page>
