<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { ConfirmButton, Notice, Segmented, SidePanel } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { api } from '#lib/api.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import {
		DEFAULT_URLS,
		KINDS,
		type ModelList,
		type Provider,
		type ProviderKind,
	} from './types.js';

	/**
	 * Adds a provider (`provider` is null) or shows and edits one: connection test, name, address,
	 * key and removal. Opens as a panel beside the page and as a sheet on phones.
	 */
	let {
		open,
		provider,
		onclose,
		onchanged,
		onmodels,
	}: {
		open: boolean;
		provider: Provider | null;
		onclose: () => void;
		onchanged: () => void;
		/** Models found by a successful test, for the model pickers. */
		onmodels: (providerId: string, models: string[], zeroRetentionModels?: string[]) => void;
	} = $props();

	let kind = $state<ProviderKind>('openrouter');
	let name = $state('');
	let baseUrl = $state('');
	let apiKey = $state('');
	let error = $state(false);
	let test = $state<ModelList | 'running' | null>(null);
	let form = $state<HTMLFormElement>();

	const kindName = (k: ProviderKind) => tDynamic(`app:ai_kind_${k}`).replace(/\s*\(.*\)$/, '');

	// A fresh form whenever the panel opens on another provider (or for a new one).
	let shownFor: string | null | undefined;
	$effect(() => {
		if (!open) {
			shownFor = undefined;
			return;
		}
		const key = provider?.id ?? null;
		if (shownFor === key) return;
		shownFor = key;
		error = false;
		test = null;
		apiKey = '';
		if (provider) {
			kind = provider.kind;
			name = provider.name;
			baseUrl = provider.baseUrl;
		} else {
			pickKind('openrouter');
		}
	});

	function pickKind(next: string) {
		kind = next as ProviderKind;
		name = kindName(kind);
		baseUrl = DEFAULT_URLS[kind];
	}

	async function save() {
		error = false;
		try {
			if (provider) {
				unwrap(
					await api.PATCH('/api/v1/ai/providers/{providerId}', {
						params: { path: { providerId: provider.id } },
						body: {
							name,
							baseUrl,
							...(apiKey.trim() && { apiKey: apiKey.trim() }),
						},
					}),
				);
			} else {
				unwrap(
					await api.POST('/api/v1/ai/providers', {
						body: {
							name,
							kind,
							...(baseUrl.trim() && { baseUrl: baseUrl.trim() }),
							...(apiKey.trim() && { apiKey: apiKey.trim() }),
						},
					}),
				);
			}
			onchanged();
			onclose();
		} catch {
			error = true;
		}
	}

	async function runTest() {
		if (!provider) return;
		test = 'running';
		try {
			const result = unwrap(
				await api.GET('/api/v1/ai/providers/{providerId}/models', {
					params: { path: { providerId: provider.id } },
				}),
			);
			test = result;
			if (result.ok) onmodels(provider.id, result.models, result.zeroRetentionModels);
		} catch {
			test = { ok: false, reason: 'unexpected', message: '' };
		}
	}

	async function removeKey() {
		if (!provider) return;
		await api.PATCH('/api/v1/ai/providers/{providerId}', {
			params: { path: { providerId: provider.id } },
			body: { apiKey: null },
		});
		onchanged();
	}

	async function remove() {
		if (!provider) return;
		await api.DELETE('/api/v1/ai/providers/{providerId}', {
			params: { path: { providerId: provider.id } },
		});
		onchanged();
		onclose();
	}

	const managed = $derived(provider?.managed === true);
	const keyStatus = $derived(
		!provider?.hasKey
			? t('ai_no_key')
			: provider.keyReadable
				? t('ai_key_stored')
				: t('ai_key_unreadable'),
	);
</script>

{#snippet removeButton()}
	<ConfirmButton label={t('ai_remove')} confirmLabel={t('ai_remove_confirm')} onconfirm={remove} />
{/snippet}

<SidePanel
	{open}
	title={provider ? provider.name : t('ai_add_provider')}
	{onclose}
	closeLabel={t('side_panel_close')}
	cancelLabel={t('ai_cancel')}
	saveLabel={managed ? undefined : provider ? t('ai_save') : t('ai_add_provider')}
	onsave={managed ? undefined : () => form?.requestSubmit()}
	danger={provider && !managed ? removeButton : undefined}
>
	<div class="grid gap-5">
		{#if managed}
			<Notice>{t('ai_provider_managed')}</Notice>
		{/if}
		{#if !provider}
			<Segmented
				label={t('ai_providers')}
				grow
				value={kind}
				onchange={pickKind}
				options={KINDS.map((k) => ({ value: k, label: kindName(k) }))}
			/>
			<p class="text-ink-soft text-sm">{tDynamic(`app:ai_kind_hint_${kind}`)}</p>
		{:else}
			<p class="text-ink-soft text-sm">
				{tDynamic(`app:ai_kind_${provider.kind}`)} · {keyStatus}
			</p>
		{/if}

		{#if !managed}
			<form
				bind:this={form}
				onsubmit={(e) => {
					e.preventDefault();
					void save();
				}}
				class="grid gap-4"
			>
				<div class="grid gap-1.5">
					<Label for="provider-name">{t('ai_name')}</Label>
					<Input
						id="provider-name"
						bind:value={name}
						required
						maxlength={60}
						aria-describedby="provider-name-hint"
					/>
					<small id="provider-name-hint" class="text-ink-soft text-[13px] leading-snug"
						>{t('ai_name_hint')}</small
					>
				</div>
				<div class="grid gap-1.5">
					<Label for="provider-url">{t('ai_base_url')}</Label>
					<Input
						id="provider-url"
						type="url"
						bind:value={baseUrl}
						required={provider !== null || kind === 'openai-compatible'}
						placeholder="https://…/v1"
						aria-describedby="provider-url-hint"
					/>
					<small id="provider-url-hint" class="text-ink-soft text-[13px] leading-snug"
						>{t('ai_base_url_hint')}</small
					>
				</div>
				{#if kind !== 'ollama'}
					<div class="grid gap-1.5">
						<Label for="provider-key">{provider ? t('ai_api_key_new') : t('ai_api_key')}</Label>
						<Input
							id="provider-key"
							type="password"
							bind:value={apiKey}
							required={!provider && kind === 'openrouter'}
							autocomplete="off"
							placeholder={provider ? t('ai_api_key_keep') : undefined}
							aria-describedby="provider-key-hint"
						/>
						<small id="provider-key-hint" class="text-ink-soft text-[13px] leading-snug"
							>{t('ai_api_key_hint')}</small
						>
					</div>
				{/if}
				{#if provider?.hasKey && baseUrl.trim() !== provider.baseUrl && !apiKey.trim()}
					<Notice tone="warn">{t('ai_key_dropped_on_move')}</Notice>
				{/if}
				{#if error}<Notice tone="alert">{t('error_generic')}</Notice>{/if}
			</form>
		{/if}

		{#if provider}
			<div class="grid gap-3">
				<div class="flex flex-wrap items-center gap-2">
					<Button variant="outline" onclick={runTest} disabled={test === 'running'}>
						{test === 'running' ? t('ai_testing') : t('ai_test')}
					</Button>
					{#if provider.hasKey && !managed}
						<Button variant="ghost" onclick={removeKey}>{t('ai_remove_key')}</Button>
					{/if}
				</div>
				{#if test && test !== 'running'}
					<div role="status">
						<Notice tone={test.ok ? 'info' : 'warn'}>
							{#if test.ok}
								{t('ai_test_ok', { count: test.models.length })}
							{:else if test.reason === 'auth'}
								{t('ai_test_auth')}
							{:else if test.reason === 'unreachable'}
								{t('ai_test_unreachable')}
							{:else}
								{t('ai_test_unexpected', { message: test.message })}
							{/if}
						</Notice>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</SidePanel>
