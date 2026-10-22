<script lang="ts">
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		Dialog,
		EmptyState,
		Notice,
		Page,
		PageHeader,
		Row,
		Section,
		SwitchRow,
	} from '@famos/ui/famos';
	import { ChevronRight, KeyRound, Plug, Plus, UserCheck } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { family } from '#lib/family.svelte.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import { appSettings, mcpAddress } from './app-settings.js';
	import { appIsLive, nextWarning, showsSignedIn } from './apps.js';
	import AppPanel, { type ConnectedApp } from './AppPanel.svelte';
	import ConnectApp from './ConnectApp.svelte';
	import {
		registerBlocked,
		type OAuthState,
		showsHttpSwitch,
		signinBlocked,
		signinHintKey,
	} from './oauth-settings.js';

	type Json<P extends keyof paths> = paths[P] extends {
		get: { responses: { 200: { content: { 'application/json': infer R } } } };
	}
		? R
		: never;
	type Token = Json<'/api/v1/mcp/tokens'>['tokens'][number];
	type Roles = Json<'/api/v1/core/roles'>;
	type OAuth = Json<'/api/v1/mcp/oauth'>;
	type Client = Json<'/api/v1/mcp/oauth-clients'>['clients'][number];

	/** Personal app keys (API tokens) for AI apps that speak MCP; "Connect an AI app" walks
	 * through turning it on, creating a key and copying the settings into the app. */
	let enabled = $state<boolean | null>(null);
	let mine = $state<Token[]>([]);
	let everyone = $state<Token[]>([]);
	let error = $state<string | null>(null);
	let connecting = $state(false);
	/** Turning AI apps on asks first; the switch stays where it was until the answer. */
	let confirmingOn = $state(false);
	let switchKey = $state(0);

	/** AI apps signing in with a family account: the admin's switches, and the apps set up for it. */
	let oauth = $state<OAuth | null>(null);
	let myClients = $state<Client[]>([]);
	let allClients = $state<Client[]>([]);
	/** Allowing plain http asks first, with its warning. */
	let confirmingHttp = $state(false);
	let oauthKey = $state(0);

	/** Programs with a key of their own (Home Assistant, scripts): an admin's to look after. */
	let apps = $state<ConnectedApp[]>([]);
	let roles = $state<Roles['roles']>([]);
	let warnDays = $state(14);
	/** The app open in the panel: an id, `new`, or none. */
	let panel = $state<string | null>(null);
	const mayManageApps = $derived(
		session.can('core.apps.manage') && session.me?.fullSignIn === true,
	);
	const shownApps = $derived(apps.filter((a) => a.revokedAt === null));
	const openApp = $derived(apps.find((a) => a.id === panel) ?? null);

	const isAdmin = $derived(session.can('core.ai.manage'));
	/** Keys are made only where they can work: when AI apps may connect, or by an admin who can
	 * turn that on. */
	const usable = $derived(enabled === true || (enabled === false && isAdmin));
	/** A key works away from this device for months, so a PIN sign-in cannot make one. */
	const mayCreate = $derived(session.me?.fullSignIn === true);
	const endpoint = mcpAddress(window.location.origin);
	const example = appSettings('other', endpoint, null);
	/** Other people's tokens that still work (an admin can revoke them). */
	const others = $derived(
		isAdmin ? everyone.filter((token) => live(token) && !mine.some((m) => m.id === token.id)) : [],
	);
	const otherClients = $derived(
		isAdmin ? allClients.filter((c) => !myClients.some((m) => m.id === c.id)) : [],
	);
	const oauthState = $derived<OAuthState | null>(oauth);
	const signinReason = $derived(oauthState ? signinBlocked(oauthState, enabled === true) : null);
	const registerReason = $derived(oauthState ? registerBlocked(oauthState) : null);
	const when = (ms: number) => dateTimeFormat({ dateStyle: 'medium' }).format(ms);
	const status = (token: Token) =>
		token.revokedAt !== null
			? t('mcp_revoked')
			: token.expiresAt !== null && token.expiresAt <= Date.now()
				? t('mcp_expired')
				: token.signedIn
					? t('mcp_ends_unused')
					: t('mcp_expires', { date: token.expiresAt ? when(token.expiresAt) : '-' });
	const live = (token: Token) =>
		token.revokedAt === null && (token.expiresAt === null || token.expiresAt > Date.now());

	async function load() {
		const [settings, list] = await Promise.all([
			api.GET('/api/v1/mcp/settings'),
			api.GET('/api/v1/mcp/tokens'),
		]);
		enabled = settings.data?.enabled ?? false;
		mine = list.data?.tokens ?? [];
		if (isAdmin)
			everyone =
				(await api.GET('/api/v1/mcp/tokens', { params: { query: { all: 'true' } } })).data
					?.tokens ?? [];
		await loadOAuth();
	}

	async function loadOAuth() {
		const [status, own] = await Promise.all([
			api.GET('/api/v1/mcp/oauth'),
			api.GET('/api/v1/mcp/oauth-clients'),
		]);
		oauth = status.data ?? null;
		myClients = own.data?.clients ?? [];
		if (isAdmin)
			allClients =
				(await api.GET('/api/v1/mcp/oauth-clients', { params: { query: { all: 'true' } } })).data
					?.clients ?? [];
	}
	$effect(() => {
		if (session.can('core.mcp.use')) void load();
	});

	async function loadApps() {
		const [list, roleList] = await Promise.all([
			api.GET('/api/v1/apps'),
			api.GET('/api/v1/core/roles'),
		]);
		apps = list.data?.apps ?? [];
		warnDays = list.data?.warnDays ?? 14;
		roles = roleList.data?.roles ?? [];
	}
	$effect(() => {
		if (mayManageApps) void loadApps();
	});
	$effect(() => {
		if (mayManageApps) return onEvent('core.role.', () => void loadApps());
	});

	const appMeta = (app: ConnectedApp) => {
		const names = app.actsFor
			.map((id) => family.members.find((m) => m.id === id)?.displayName)
			.filter((n): n is string => !!n);
		const role = roles.find((r) => r.id === app.roleId);
		const parts = [
			role?.name ?? tDynamic(`app:role_${app.roleId}`),
			app.mode === 'apply' ? t('apps_mode_apply') : t('apps_mode_suggest'),
			names.length > 0 ? t('apps_acts_for', { names: names.join(', ') }) : t('apps_acts_alone'),
			app.lastUsedAt ? t('apps_used', { date: when(app.lastUsedAt) }) : t('apps_never_used'),
		];
		if (app.pausedAt !== null) parts.unshift(t('apps_paused'));
		const soon = nextWarning(app.tokens, Date.now(), warnDays);
		if (soon !== null) parts.push(t('apps_key_expiring', { date: when(soon) }));
		return parts.join(' · ');
	};

	async function setEnabled(on: boolean): Promise<boolean> {
		try {
			unwrap(await api.POST('/api/v1/actions/core.setMcpEnabled', { body: { enabled: on } }));
			enabled = on;
			return true;
		} catch {
			error = t('error_generic');
			return false;
		}
	}

	/** One switch for the whole family, so the notice says what it is now and offers Undo. */
	async function switchTo(on: boolean, undoable = true) {
		error = null;
		if (!(await setEnabled(on))) {
			switchKey += 1;
			return;
		}
		toasts.show(
			t(on ? 'mcp_turned_on' : 'mcp_turned_off'),
			undoable ? { label: t('mcp_switch_undo'), run: () => void switchTo(!on, false) } : undefined,
		);
	}

	function onSwitch(on: boolean) {
		if (on) {
			confirmingOn = true;
			// Put the switch back until the answer.
			switchKey += 1;
		} else void switchTo(false);
	}

	async function setOAuth(patch: {
		oauthEnabled?: boolean;
		dcrEnabled?: boolean;
		allowPlainHttp?: boolean;
	}): Promise<boolean> {
		error = null;
		try {
			unwrap(await api.POST('/api/v1/actions/core.setMcpOAuth', { body: patch }));
			await loadOAuth();
			return true;
		} catch {
			error = t('error_generic');
			oauthKey += 1;
			return false;
		}
	}

	async function switchSignin(on: boolean) {
		if (await setOAuth({ oauthEnabled: on }))
			toasts.show(t(on ? 'mcp_signin_turned_on' : 'mcp_signin_turned_off'));
	}

	function onHttp(on: boolean) {
		if (on) {
			confirmingHttp = true;
			// Put the switch back until the answer.
			oauthKey += 1;
		} else void setOAuth({ allowPlainHttp: false });
	}

	async function removeClient(client: Client) {
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.deleteOAuthClient', { body: { clientId: client.id } }),
			);
			toasts.show(t('mcp_client_removed', { name: client.name }));
			await load();
		} catch {
			error = t('error_generic');
		}
	}

	const reasonText = (reason: string) => tDynamic(`app:${reason}`);

	async function revoke(id: string) {
		error = null;
		try {
			unwrap(await api.POST('/api/v1/actions/core.revokeApiToken', { body: { tokenId: id } }));
			await load();
		} catch {
			error = t('error_generic');
		}
	}
</script>

{#snippet clientRow(client: Client, withOwner: boolean)}
	<Row
		wrap
		title={client.name}
		meta="{withOwner && client.owner
			? t('mcp_client_meta_owner', { owner: client.owner, date: when(client.createdAt) })
			: t('mcp_client_meta', { date: when(client.createdAt) })} · {client.lastConsentedAt
			? t('mcp_client_last', { date: when(client.lastConsentedAt) })
			: t('mcp_client_never')}"
	>
		{#snippet lead()}<Plug class="size-5" aria-hidden="true" />{/snippet}
		{#snippet trail()}
			<ConfirmButton
				label={t('mcp_client_remove')}
				confirmLabel={t('mcp_client_remove_confirm')}
				onconfirm={() => removeClient(client)}
			/>
		{/snippet}
	</Row>
{/snippet}

<Page template="settings">
	<PageHeader title={t('nav_connected_apps')} subtitle={t('mcp_intro')}>
		{#snippet actions()}
			{#if usable && mayCreate}
				<Button variant="primary" onclick={() => (connecting = true)}
					><Plus aria-hidden="true" />{t('mcp_add')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="grid gap-7">
		{#if mayManageApps}
			<Section label={t('apps_section')} count={shownApps.length}>
				{#snippet actions()}
					<Button variant="ghost" size="sm" onclick={() => (panel = 'new')}
						><Plus class="size-4" aria-hidden="true" />{t('apps_add')}</Button
					>
				{/snippet}
				{#if shownApps.length > 0}
					<Card rows>
						{#each shownApps as app (app.id)}
							<Row
								wrap
								title={app.name}
								idle={!appIsLive(app)}
								meta={appMeta(app)}
								onclick={() => (panel = app.id)}
							>
								{#snippet lead()}<Plug class="size-5" aria-hidden="true" />{/snippet}
								{#snippet trail()}<ChevronRight class="size-4" aria-hidden="true" />{/snippet}
							</Row>
						{/each}
					</Card>
				{:else}
					<EmptyState art="assistant" title={t('apps_empty_title')} hint={t('apps_empty_hint')}
					></EmptyState>
				{/if}
			</Section>
		{/if}
		{#if isAdmin}
			<Section label={t('mcp_switch_title')}>
				<Card rows>
					{#key switchKey}
						<SwitchRow
							id="mcp-enabled"
							label={t('mcp_switch')}
							hint={enabled ? t('mcp_switch_hint_on') : t('mcp_switch_hint')}
							checked={enabled === true}
							onchange={onSwitch}
						/>
					{/key}
					{#if oauth}
						{#key oauthKey}
							<SwitchRow
								id="mcp-signin"
								label={t('mcp_signin_switch')}
								hint={signinReason ? reasonText(signinReason) : t(signinHintKey(oauth))}
								checked={oauth.oauthEnabled}
								disabled={signinReason !== null}
								onchange={switchSignin}
							/>
							<SwitchRow
								id="mcp-register"
								label={t('mcp_register_switch')}
								hint={registerReason ? reasonText(registerReason) : t('mcp_register_hint')}
								checked={oauth.dcrEnabled}
								disabled={registerReason !== null}
								onchange={(on) => void setOAuth({ dcrEnabled: on })}
							/>
							{#if showsHttpSwitch(oauth)}
								<SwitchRow
									id="mcp-http"
									label={t('mcp_http_switch')}
									hint={t('mcp_http_hint')}
									checked={oauth.allowPlainHttp}
									onchange={onHttp}
								/>
							{/if}
						{/key}
					{/if}
				</Card>
				{#if oauth?.allowPlainHttp}
					<div class="mt-3" data-testid="mcp-http-warning">
						<Notice tone="warn">{t('mcp_http_warning')}</Notice>
					</div>
				{/if}
			</Section>
		{/if}
		{#if usable && !mayCreate}
			<div data-testid="mcp-password-needed">
				<Notice tone="info">{t('sign_in_password_for_keys')}</Notice>
			</div>
		{/if}
		{#if enabled === false}
			<div data-testid="mcp-off">
				<Notice tone="warn">{isAdmin ? t('mcp_off_admin') : t('mcp_off')}</Notice>
			</div>
		{/if}

		{#if usable || mine.length > 0}
			<Section label={t('mcp_mine')} count={mine.length}>
				{#if mine.length > 0}
					<Card rows>
						{#each mine as token (token.id)}
							<Row
								wrap
								title={token.name}
								idle={!live(token)}
								meta="{showsSignedIn(token, Date.now())
									? `${t('mcp_signed_in')} · `
									: ''}{token.scope === 'read'
									? t('mcp_scope_read_short')
									: t('mcp_scope_read_write_short')} · {status(token)} · {token.lastUsedAt
									? t('mcp_last_used', { date: when(token.lastUsedAt) })
									: t('mcp_never_used')}"
							>
								{#snippet lead()}
									{#if token.signedIn}<UserCheck
											class="size-5"
											aria-hidden="true"
										/>{:else}<KeyRound class="size-5" aria-hidden="true" />{/if}
								{/snippet}
								{#snippet trail()}
									{#if live(token)}
										<ConfirmButton
											label={t('mcp_revoke')}
											confirmLabel={t('mcp_revoke_confirm')}
											onconfirm={() => revoke(token.id)}
										/>
									{/if}
								{/snippet}
							</Row>
						{/each}
					</Card>
				{:else}
					<EmptyState art="assistant" title={t('mcp_none')} hint={t('mcp_none_hint')}></EmptyState>
				{/if}
				{#if error}<p class="text-destructive text-sm" role="alert">{error}</p>{/if}
			</Section>
		{/if}

		{#if others.length > 0}
			<Section label={t('mcp_all')} count={others.length}>
				<Card rows>
					{#each others as token (token.id)}
						<Row wrap title="{token.member} · {token.name}" meta={status(token)}>
							{#snippet trail()}
								<ConfirmButton
									label={t('mcp_revoke')}
									confirmLabel={t('mcp_revoke_confirm')}
									onconfirm={() => revoke(token.id)}
								/>
							{/snippet}
						</Row>
					{/each}
				</Card>
			</Section>
		{/if}

		{#if myClients.length > 0}
			<Section label={t('mcp_clients')} count={myClients.length}>
				<Card rows>
					{#each myClients as client (client.id)}
						{@render clientRow(client, false)}
					{/each}
				</Card>
			</Section>
		{/if}
		{#if otherClients.length > 0}
			<Section label={t('mcp_clients_all')} count={otherClients.length}>
				<Card rows>
					{#each otherClients as client (client.id)}
						{@render clientRow(client, true)}
					{/each}
				</Card>
			</Section>
		{/if}

		{#if usable}
			<details
				class="bg-surface group rounded-[var(--r-card)] shadow-[inset_0_0_0_1px_var(--line)]"
			>
				<summary
					class="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-[var(--r-card)] px-4 font-bold outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--info)] [&::-webkit-details-marker]:hidden"
				>
					<ChevronRight
						class="size-4 transition-transform group-open:rotate-90"
						aria-hidden="true"
					/>
					<h2>{t('mcp_howto')}</h2>
				</summary>
				<div class="border-line grid gap-4 border-t px-4 py-4">
					<p class="text-ink-soft text-sm">{t('mcp_howto_intro')}</p>
					<div class="grid gap-1">
						<span class="text-sm font-semibold">{t('mcp_endpoint')}</span>
						<code class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
							>{endpoint}</code
						>
					</div>
					<div class="grid gap-1">
						<span class="text-sm font-semibold">{t('mcp_example')}</span>
						<pre
							class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{example}</pre>
					</div>
					<p class="text-ink-soft text-sm">{t('mcp_howto_safety')}</p>
					<p class="text-ink-soft text-sm">{t('mcp_howto_oauth')}</p>
				</div>
			</details>
		{/if}
	</div>

	<AppPanel
		open={panel !== null && (panel === 'new' || openApp !== null)}
		app={panel === 'new' ? null : openApp}
		{roles}
		{warnDays}
		onclose={() => (panel = null)}
		onchanged={loadApps}
		onopen={async (id) => {
			await loadApps();
			panel = id;
		}}
	/>

	<ConnectApp
		open={connecting}
		enabled={enabled === true}
		{oauth}
		canCreateClients={mayCreate}
		{isAdmin}
		onenable={() => setEnabled(true)}
		onclose={() => (connecting = false)}
		onchanged={load}
	/>

	<Dialog
		open={confirmingHttp}
		title={t('mcp_http_confirm_title')}
		description={t('mcp_http_confirm_body')}
		onclose={() => (confirmingHttp = false)}
	>
		{#snippet actions()}
			<Button variant="ghost" data-autofocus onclick={() => (confirmingHttp = false)}
				>{t('cancel')}</Button
			>
			<Button
				variant="primary"
				onclick={() => {
					confirmingHttp = false;
					void setOAuth({ allowPlainHttp: true });
				}}>{t('mcp_http_confirm_on')}</Button
			>
		{/snippet}
	</Dialog>

	<Dialog
		open={confirmingOn}
		title={t('mcp_confirm_title')}
		description={t('mcp_confirm_body')}
		onclose={() => (confirmingOn = false)}
	>
		{#snippet actions()}
			<Button variant="ghost" data-autofocus onclick={() => (confirmingOn = false)}
				>{t('cancel')}</Button
			>
			<Button
				variant="primary"
				onclick={() => {
					confirmingOn = false;
					void switchTo(true);
				}}>{t('mcp_turn_on')}</Button
			>
		{/snippet}
	</Dialog>
</Page>
