<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		FIELD_REASON,
		fieldAria,
		FieldError,
		focusFirstInvalid,
		Notice,
		Row,
		Segmented,
		SidePanel,
		Step,
		Steps,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ChevronLeft, ChevronRight, Check, Copy, KeyRound, Link, Plug } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import { api } from '#lib/api.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import SelectField from '#lib/SelectField.svelte';
	import { APP_KINDS, type AppKind, appSettings, mcpAddress } from './app-settings.js';

	/**
	 * "Connect an AI app" (guided steps): turn AI apps on (once, for the whole family; an
	 * admin), create a key for the app, copy the settings into the app. The key is shown only in
	 * the last step, once.
	 */
	let {
		open,
		enabled,
		oauth,
		canCreateClients,
		isAdmin,
		onenable,
		onclose,
		onchanged,
	}: {
		open: boolean;
		/** Whether AI apps may connect for the family. */
		enabled: boolean;
		/** Signing in with a family account: null until read. */
		oauth: { active: boolean; mcpUrl: string | null } | null;
		/** Setting up an app that signs in shows a secret once, so it needs a password sign-in. */
		canCreateClients: boolean;
		isAdmin: boolean;
		/** Turns AI apps on; true when it worked. */
		onenable: () => Promise<boolean>;
		onclose: () => void;
		/** A key was created: the page reloads its list. */
		onchanged: () => void;
	} = $props();

	/** Which way to connect; the question comes first only when there is more than one way. */
	let choice = $state<'key' | 'signin' | 'ha' | null>('key');
	let haAddress = $state('');
	let haMade = $state<{ clientId: string; secret: string; mcpUrl: string | null } | null>(null);
	let step = $state(1);
	let name = $state('');
	let scope = $state<'read' | 'read_write'>('read');
	let days = $state(90);
	let made = $state<{ name: string; secret: string } | null>(null);
	let kind = $state<AppKind>('claude-desktop');
	let copied = $state<'key' | 'settings' | 'secret' | 'client' | 'address' | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	// The name's reason shows from the first refused Create on, and goes once it is typed.
	let tried = $state(false);
	const nameError = $derived(tried && !name.trim() ? FIELD_REASON.name : undefined);

	const address = mcpAddress(typeof location === 'undefined' ? '' : location.origin);
	const settings = $derived(appSettings(kind, address, made?.secret ?? null));

	// Each opening starts fresh; the first step is done when AI apps are already on. Only the
	// opening counts: the page reloading its lists in the middle must not start the panel over.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			choice = oauth?.active ? null : 'key';
			haAddress = '';
			haMade = null;
			step = enabled ? 2 : 1;
			name = '';
			scope = 'read';
			days = 90;
			made = null;
			kind = 'claude-desktop';
			copied = null;
			error = null;
			tried = false;
		});
	});

	/** The steps of a way start at their first open one: the key's second when AI apps are on already. */
	function pick(next: 'key' | 'signin' | 'ha') {
		choice = next;
		step = next === 'key' && enabled ? 2 : 1;
	}

	async function turnOn() {
		error = null;
		busy = true;
		try {
			if (await onenable()) step = 2;
			else error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		if (!name.trim()) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		error = null;
		busy = true;
		try {
			const result = unwrap(
				await api.POST('/api/v1/mcp/tokens', { body: { name, scope, expiresInDays: days } }),
			);
			made = { name, secret: result.secret };
			step = 3;
			onchanged();
		} catch {
			error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function setUpHomeAssistant(event: SubmitEvent) {
		event.preventDefault();
		error = null;
		busy = true;
		try {
			const address = haAddress.trim();
			const result = unwrap(
				await api.POST('/api/v1/mcp/oauth-clients', {
					body: { preset: 'ha', ...(address && { homeAssistantUrl: address }) },
				}),
			);
			haMade = {
				clientId: result.client.clientId,
				secret: result.clientSecret,
				mcpUrl: result.mcpUrl,
			};
			step = 2;
			onchanged();
		} catch {
			error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function copy(text: string, what: NonNullable<typeof copied>) {
		try {
			await navigator.clipboard.writeText(text);
			copied = what;
		} catch {
			// The text is selectable; copying by hand still works.
		}
	}
</script>

{#snippet copyButton(text: string, what: NonNullable<typeof copied>)}
	<Button size="sm" variant="secondary" onclick={() => copy(text, what)}>
		{#if copied === what}<Check class="size-4" aria-hidden="true" />{:else}<Copy
				class="size-4"
				aria-hidden="true"
			/>{/if}
		{copied === what ? t('mcp_copied') : t('mcp_copy')}
	</Button>
{/snippet}

<SidePanel
	{open}
	title={t('mcp_add')}
	closeLabel={t('side_panel_close')}
	cancelLabel={choice === 'key'
		? step === 3
			? t('devices_close')
			: t('cancel')
		: choice === 'ha' && step === 2
			? t('devices_close')
			: t('cancel')}
	{onclose}
	dirty={(choice === 'key' && step === 2 && name !== '') ||
		(choice === 'ha' && step === 1 && haAddress !== '')}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	<div class="grid gap-5" data-testid="connect-app">
		{#if choice === null}
			<section class="grid gap-2" aria-labelledby="which-app">
				<h3 id="which-app" class="text-ink-soft text-xs font-semibold tracking-wide uppercase">
					{t('mcp_which_title')}
				</h3>
				<div class="bg-surface rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]">
					<Row
						title={t('mcp_choice_key')}
						meta={t('mcp_choice_key_hint')}
						wrap
						onclick={() => pick('key')}
					>
						{#snippet lead()}<KeyRound class="size-5" aria-hidden="true" />{/snippet}
						{#snippet trail()}<ChevronRight class="size-4" aria-hidden="true" />{/snippet}
					</Row>
					<Row
						title={t('mcp_choice_signin')}
						meta={t('mcp_choice_signin_hint')}
						wrap
						onclick={() => pick('signin')}
					>
						{#snippet lead()}<Link class="size-5" aria-hidden="true" />{/snippet}
						{#snippet trail()}<ChevronRight class="size-4" aria-hidden="true" />{/snippet}
					</Row>
					{#if canCreateClients}
						<Row
							title={t('mcp_choice_ha')}
							meta={t('mcp_choice_ha_hint')}
							wrap
							onclick={() => pick('ha')}
						>
							{#snippet lead()}<Plug class="size-5" aria-hidden="true" />{/snippet}
							{#snippet trail()}<ChevronRight class="size-4" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
				</div>
			</section>
		{:else}
			{#if oauth?.active && !(choice === 'ha' && haMade) && !(choice === 'key' && made)}
				<div>
					<Button variant="ghost" size="sm" onclick={() => (choice = null)}
						><ChevronLeft class="size-4" aria-hidden="true" />{t('mcp_which_title')}</Button
					>
				</div>
			{/if}
		{/if}
		{#if choice === 'signin'}
			<div class="grid gap-3" data-testid="signin-address">
				<h3 class="font-bold">{t('mcp_signin_page_title')}</h3>
				<p class="text-ink-soft text-sm">{t('mcp_signin_page_body')}</p>
				<code class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
					>{oauth?.mcpUrl ?? address}</code
				>
				<div>{@render copyButton(oauth?.mcpUrl ?? address, 'address')}</div>
				<div><Button variant="primary" onclick={onclose}>{t('mcp_done')}</Button></div>
			</div>
		{:else if choice === 'ha'}
			<Steps current={step} label={t('mcp_choice_ha')} doneLabel={t('steps_done')}>
				<Step n={1} title={t('mcp_ha_step_set')} summary={haMade ? t('mcp_choice_ha') : undefined}>
					<p class="text-ink-soft text-sm">{t('mcp_ha_step_set_body')}</p>
					<form class="grid gap-4" onsubmit={setUpHomeAssistant}>
						<div class="grid gap-1.5">
							<Label for="ha-address">{t('mcp_ha_address')}</Label>
							<Input
								id="ha-address"
								bind:value={haAddress}
								type="url"
								maxlength={2000}
								placeholder="http://homeassistant.local:8123"
								aria-describedby="ha-address-hint"
							/>
							<small id="ha-address-hint" class="text-ink-soft text-[13px] leading-snug"
								>{t('mcp_ha_address_hint')}</small
							>
						</div>
						{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
						<div>
							<Button type="submit" variant="primary" disabled={busy}>{t('mcp_ha_create')}</Button>
						</div>
					</form>
				</Step>
				<Step n={2} title={t('mcp_ha_step_paste')}>
					{#if haMade}
						<div class="grid gap-3" data-testid="ha-credentials">
							<p class="text-sm font-semibold">{t('mcp_ha_secret_once')}</p>
							<div class="grid gap-1">
								<span class="text-sm font-semibold">{t('mcp_ha_client_id')}</span>
								<code
									class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
									data-testid="ha-client-id">{haMade.clientId}</code
								>
								<div>{@render copyButton(haMade.clientId, 'client')}</div>
							</div>
							<div class="grid gap-1">
								<span class="text-sm font-semibold">{t('mcp_ha_client_secret')}</span>
								<code
									class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
									data-testid="ha-client-secret">{haMade.secret}</code
								>
								<div>{@render copyButton(haMade.secret, 'secret')}</div>
							</div>
							<div class="grid gap-1">
								<span class="text-sm font-semibold">{t('mcp_endpoint')}</span>
								<code
									class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
									data-testid="ha-address-out">{haMade.mcpUrl ?? address}</code
								>
								<div>{@render copyButton(haMade.mcpUrl ?? address, 'address')}</div>
							</div>
							<p class="text-ink-soft text-sm">{t('mcp_ha_where')}</p>
						</div>
					{/if}
					<div><Button variant="primary" onclick={onclose}>{t('mcp_done')}</Button></div>
				</Step>
			</Steps>
		{:else if choice === 'key'}
			<Steps current={step} label={t('mcp_add')} doneLabel={t('steps_done')}>
				<Step n={1} title={t('mcp_step_on')} summary={t('mcp_step_on_summary')}>
					<p class="text-ink-soft text-sm">{t('mcp_step_on_body')}</p>
					{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
					<div>
						{#if isAdmin}
							<Button variant="primary" disabled={busy} onclick={turnOn}>{t('mcp_turn_on')}</Button>
						{:else}
							<Notice tone="warn">{t('mcp_off')}</Notice>
						{/if}
					</div>
				</Step>

				<Step n={2} title={t('mcp_step_key')} summary={made?.name}>
					<p class="text-ink-soft text-sm">{t('mcp_step_key_body')}</p>
					<form class="grid gap-4" onsubmit={create} novalidate>
						<div class="grid gap-1.5">
							<Label for="mcp-name">{t('mcp_name')}</Label>
							<Input
								id="mcp-name"
								bind:value={name}
								required
								maxlength={60}
								placeholder={t('mcp_name_placeholder')}
								aria-describedby={nameError ? 'mcp-name-error mcp-name-hint' : 'mcp-name-hint'}
								aria-invalid={nameError ? 'true' : undefined}
							/>
							<FieldError for="mcp-name" error={nameError} />
							<small id="mcp-name-hint" class="text-ink-soft text-[13px] leading-snug"
								>{t('mcp_name_hint')}</small
							>
						</div>
						<div class="grid gap-1.5">
							<Label for="mcp-scope">{t('mcp_scope')}</Label>
							<SelectField id="mcp-scope" bind:value={scope}>
								<option value="read">{t('mcp_scope_read')}</option>
								<option value="read_write">{t('mcp_scope_read_write')}</option>
							</SelectField>
							<small class="text-ink-soft text-[13px] leading-snug">{t('mcp_scope_hint')}</small>
						</div>
						<div class="grid gap-1.5">
							<Label for="mcp-days">{t('mcp_expiry')}</Label>
							<SelectField id="mcp-days" bind:value={days}>
								{#each [30, 90, 180, 365] as option (option)}
									<option value={option}>{t('mcp_expiry_days', { count: option })}</option>
								{/each}
							</SelectField>
						</div>
						{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
						<div>
							<Button type="submit" variant="primary" disabled={busy}>{t('mcp_create')}</Button>
						</div>
					</form>
				</Step>

				<Step n={3} title={t('mcp_step_copy')}>
					{#if made}
						<div class="grid gap-2" data-testid="mcp-secret-box">
							<p class="text-sm font-semibold">{t('mcp_secret_once')}</p>
							<code
								class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
								data-testid="mcp-secret">{made.secret}</code
							>
							<div>{@render copyButton(made.secret, 'key')}</div>
						</div>
					{/if}
					<div class="grid gap-2">
						<Segmented
							label={t('mcp_which_app')}
							size="sm"
							grow
							value={kind}
							onchange={(v) => {
								kind = v as AppKind;
								copied = copied === 'settings' ? null : copied;
							}}
							options={APP_KINDS.map((k) => ({
								value: k,
								label: tDynamic(`app:mcp_kind_${k.replace('-', '_')}`),
							}))}
						/>
						<p class="text-ink-soft text-sm">
							{tDynamic(`app:mcp_kind_${kind.replace('-', '_')}_how`)}
						</p>
						<pre
							class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap"
							data-testid="mcp-settings">{settings}</pre>
						<div>{@render copyButton(settings, 'settings')}</div>
					</div>
					<p class="text-ink-soft text-[13px]">
						{t('mcp_endpoint')}:
						<code class="break-all" data-testid="mcp-endpoint">{address}</code>
					</p>
					<div><Button variant="primary" onclick={onclose}>{t('mcp_done')}</Button></div>
				</Step>
			</Steps>
		{/if}
	</div>
</SidePanel>
