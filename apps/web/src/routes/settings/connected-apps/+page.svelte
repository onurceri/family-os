<script lang="ts">
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		EmptyState,
		Notice,
		Page,
		PageHeader,
		Row,
		Section,
		SwitchRow,
	} from '@famos/ui/famos';
	import { ChevronRight, KeyRound, Plus } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { t } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { appSettings, mcpAddress } from './app-settings.js';
	import ConnectApp from './ConnectApp.svelte';

	type Json<P extends keyof paths> = paths[P] extends {
		get: { responses: { 200: { content: { 'application/json': infer R } } } };
	}
		? R
		: never;
	type Token = Json<'/api/v1/mcp/tokens'>['tokens'][number];

	/** Personal app keys (API tokens) for AI apps that speak MCP; "Connect an app" walks
	 * through turning it on, creating a key and copying the settings into the app. */
	let enabled = $state<boolean | null>(null);
	let mine = $state<Token[]>([]);
	let everyone = $state<Token[]>([]);
	let error = $state<string | null>(null);
	let connecting = $state(false);

	const isAdmin = $derived(session.can('core.ai.manage'));
	/** Keys are made only where they can work: when AI apps may connect, or by an admin who can
	 * turn that on. */
	const usable = $derived(enabled === true || (enabled === false && isAdmin));
	const endpoint = mcpAddress(window.location.origin);
	const example = appSettings('other', endpoint, null);
	/** Other people's tokens that still work (an admin can revoke them). */
	const others = $derived(
		isAdmin ? everyone.filter((token) => live(token) && !mine.some((m) => m.id === token.id)) : [],
	);
	const when = (ms: number) => dateTimeFormat({ dateStyle: 'medium' }).format(ms);
	const status = (token: Token) =>
		token.revokedAt !== null
			? t('mcp_revoked')
			: token.expiresAt !== null && token.expiresAt <= Date.now()
				? t('mcp_expired')
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
	}
	$effect(() => {
		if (session.can('core.mcp.use')) void load();
	});

	async function setEnabled(on: boolean): Promise<boolean> {
		try {
			unwrap(await api.PUT('/api/v1/mcp/settings', { body: { enabled: on } }));
			enabled = on;
			return true;
		} catch {
			error = t('error_generic');
			return false;
		}
	}

	async function revoke(id: string) {
		error = null;
		try {
			unwrap(
				await api.DELETE('/api/v1/mcp/tokens/{tokenId}', { params: { path: { tokenId: id } } }),
			);
			await load();
		} catch {
			error = t('error_generic');
		}
	}
</script>

<Page template="settings">
	<PageHeader title={t('nav_connected_apps')} subtitle={t('mcp_intro')}>
		{#snippet actions()}
			{#if usable}
				<Button variant="primary" onclick={() => (connecting = true)}
					><Plus aria-hidden="true" />{t('mcp_add')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="grid gap-7">
		{#if isAdmin}
			<Section label={t('mcp_switch_title')}>
				<Card rows>
					<SwitchRow
						id="mcp-enabled"
						label={t('mcp_switch')}
						hint={t('mcp_switch_hint')}
						checked={enabled === true}
						onchange={setEnabled}
					/>
				</Card>
			</Section>
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
								meta="{token.scope === 'read'
									? t('mcp_scope_read_short')
									: t('mcp_scope_read_write_short')} · {status(token)} · {token.lastUsedAt
									? t('mcp_last_used', { date: when(token.lastUsedAt) })
									: t('mcp_never_used')}"
							>
								{#snippet lead()}<KeyRound class="size-5" aria-hidden="true" />{/snippet}
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

	<ConnectApp
		open={connecting}
		enabled={enabled === true}
		{isAdmin}
		onenable={() => setEnabled(true)}
		onclose={() => (connecting = false)}
		onchanged={load}
	/>
</Page>
