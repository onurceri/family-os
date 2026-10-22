<script lang="ts">
	import { page } from '$app/state';
	import { type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Avatar, Card, EmptyState, Notice, Page, Segmented } from '@famos/ui/famos';
	import { ShieldCheck } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { signOut } from '#lib/auth.js';
	import { contributions } from '#lib/extensions.js';
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { type Closed, closedFor, firstScope, scopeChoices } from './outcome.js';

	type Json<P extends keyof paths> = paths[P] extends {
		get: { responses: { 200: { content: { 'application/json': infer R } } } };
	}
		? R
		: never;
	type Request = Json<'/api/v1/oauth/requests/{id}'>;
	type Scope = Request['scope'];

	/**
	 * The page an AI app sends a person to, to decide whether it may connect. It is always for the
	 * person signed in, never skipped, and shows what the app is, where the answer goes back to and
	 * how far it may go. Deciding sends the browser back to the app's own address.
	 */
	const id = $derived(page.params.id ?? '');
	let request = $state<Request | null>(null);
	let closed = $state<Closed | null>(null);
	let areas = $state<string[]>([]);
	let scope = $state<Scope>('read');
	let busy = $state(false);
	let leaving = $state<string | null>(null);
	let error = $state<string | null>(null);

	const fullSignIn = $derived(session.me?.fullSignIn === true);
	const mayConnect = $derived(session.can('core.mcp.use'));
	const decidable = $derived(fullSignIn && mayConnect);
	const when = (ms: number) => dateTimeFormat({ dateStyle: 'medium' }).format(ms);
	const areaNames = $derived(
		areas
			.filter((area) => !session.disabledExtensions.includes(area))
			.map((area) => {
				const key = contributions.extension(area)?.labelKey;
				return key ? tDynamic(key) : area;
			})
			.sort((a, b) => a.localeCompare(b)),
	);

	$effect(() => {
		if (!decidable || !id) return;
		void load(id);
	});

	async function load(requestId: string) {
		const [found, status] = await Promise.all([
			api.GET('/api/v1/oauth/requests/{id}', { params: { path: { id: requestId } } }),
			api.GET('/api/v1/mcp/oauth'),
		]);
		if (!found.data) {
			closed = closedFor(found.response.status);
			return;
		}
		request = found.data;
		scope = firstScope(found.data.scope);
		areas = status.data?.areas ?? [];
	}

	async function decide(answer: 'approve' | 'deny') {
		if (!request || busy) return;
		busy = true;
		error = null;
		try {
			const result = unwrap(
				answer === 'approve'
					? await api.POST('/api/v1/oauth/requests/{id}/approve', {
							params: { path: { id: request.id } },
							body: { scope },
						})
					: await api.POST('/api/v1/oauth/requests/{id}/deny', {
							params: { path: { id: request.id } },
						}),
			);
			leaving = request.redirectHost;
			window.location.assign(result.redirectUrl);
		} catch {
			busy = false;
			error = t('connect_failed_hint');
		}
	}

	async function switchAccount() {
		await signOut();
		await session.refresh();
	}

	const differs = $derived(
		request?.client.kind === 'metadata' &&
			request.client.clientHost !== null &&
			request.client.clientHost !== request.redirectHost,
	);
</script>

{#snippet stop(title: string, hint: string, signOutToo = false)}
	<Page template="capture">
		<EmptyState art="assistant" {title} {hint}>
			{#if signOutToo}
				<Button variant="primary" onclick={switchAccount}>{t('sign_out')}</Button>
			{:else}
				<Button variant="primary" href="/">{t('connect_back_home')}</Button>
			{/if}
		</EmptyState>
	</Page>
{/snippet}

{#if !fullSignIn}
	{@render stop(t('connect_needs_password_title'), t('connect_needs_password_hint'), true)}
{:else if !mayConnect}
	{@render stop(t('connect_not_allowed_title'), t('connect_not_allowed_hint'))}
{:else if closed}
	{@render stop(tDynamic(`app:connect_${closed}_title`), tDynamic(`app:connect_${closed}_hint`))}
{:else if request}
	<Page
		template="capture"
		title={t('connect_title', { name: request.client.name })}
		subtitle={t('connect_subtitle')}
	>
		<div class="grid gap-5" data-testid="consent">
			<Card pad>
				<dl class="grid gap-5">
					<div class="fact">
						<dt>{t('connect_for_label')}</dt>
						<dd class="flex flex-wrap items-center gap-x-3 gap-y-1">
							{#if session.me}
								<span class="flex items-center gap-2 font-bold" data-testid="consent-member">
									<Avatar name={session.me.displayName} color={session.me.color} size={28} />
									{session.me.displayName}
								</span>
							{/if}
							<Button variant="ghost" size="sm" onclick={switchAccount}
								>{t('connect_not_you')}</Button
							>
						</dd>
					</div>

					<div class="fact">
						<dt>{t('connect_host_label')}</dt>
						<dd class="font-bold [overflow-wrap:anywhere]" data-testid="consent-host">
							{request.redirectHost}
						</dd>
						{#if request.loopback}
							<dd><Notice tone="warn">{t('connect_host_loopback')}</Notice></dd>
						{/if}
					</div>

					<div class="fact">
						<dt>{t('connect_trust_label')}</dt>
						<dd>
							{#if request.client.kind === 'registered'}
								<span class="inline-flex items-center gap-2">
									<ShieldCheck class="size-4" aria-hidden="true" />
									{t('connect_trust_registered', { date: when(request.client.createdAt) })}
								</span>
							{:else if request.client.kind === 'metadata'}
								{t('connect_trust_metadata', {
									host: request.client.clientHost ?? request.redirectHost,
								})}
							{:else}
								<Notice tone="alert">
									{t('connect_trust_dynamic', { date: when(request.client.createdAt) })}
								</Notice>
							{/if}
						</dd>
						{#if differs && request.client.clientHost}
							<dd>
								<Notice tone="warn">
									{t('connect_trust_metadata_differs', {
										client: request.client.clientHost,
										host: request.redirectHost,
									})}
								</Notice>
							</dd>
						{/if}
					</div>

					<div class="fact">
						<dt>{t('connect_can_label')}</dt>
						<dd class="grid gap-1">
							<span>{t('connect_can_body')}</span>
							<span class="text-ink-soft text-sm" data-testid="consent-areas">
								{areaNames.length > 0
									? t('connect_can_areas', { areas: areaNames.join(', ') })
									: t('connect_can_none')}
							</span>
							<span class="text-ink-soft text-sm">{t('connect_can_privacy')}</span>
						</dd>
					</div>

					<div class="fact">
						<dt>{t('connect_scope_label')}</dt>
						<dd class="grid gap-2">
							{#if scopeChoices(request.scope).length > 1}
								<Segmented
									label={t('connect_scope_group')}
									grow
									value={scope}
									onchange={(v) => (scope = v as Scope)}
									options={[
										{ value: 'read', label: t('connect_scope_read') },
										{ value: 'read_write', label: t('connect_scope_read_write') },
									]}
								/>
							{:else}
								<span class="font-semibold">{t('connect_scope_read')}</span>
							{/if}
							<span class="text-ink-soft text-sm">
								{scope === 'read'
									? t('connect_scope_read_hint')
									: t('connect_scope_read_write_hint')}
								{request.scope === 'read' ? t('connect_scope_asked_read') : ''}
							</span>
						</dd>
					</div>

					<p class="text-ink-soft text-sm">{t('connect_how_long')}</p>
				</dl>
			</Card>

			{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
			{#if leaving}
				<p class="text-ink-soft text-sm" role="status">
					{t('connect_going_back', { host: leaving })}
				</p>
			{/if}
			<div class="flex flex-wrap items-center gap-3">
				<Button variant="primary" disabled={busy} onclick={() => decide('approve')}
					>{t('connect_submit')}</Button
				>
				<Button variant="ghost" disabled={busy} onclick={() => decide('deny')}
					>{t('connect_cancel')}</Button
				>
			</div>
		</div>
	</Page>
{/if}

<style>
	.fact {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	dt {
		color: var(--ink-soft);
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	dd {
		margin: 0;
	}
</style>
