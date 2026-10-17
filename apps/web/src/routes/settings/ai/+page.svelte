<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		Combobox,
		EmptyState,
		Notice,
		Page,
		PageHeader,
		Pill,
		Row,
		Section,
		SettingRow,
		SwitchRow,
	} from '@famos/ui/famos';
	import { ChevronRight, Cloud, HardDrive, Plus, Server } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import SelectField from '#lib/SelectField.svelte';
	import ProviderPanel from './ProviderPanel.svelte';
	import {
		type AiSettings,
		CHAT_ROLES,
		type Provider,
		ROLES,
		type Role,
		type Roles,
	} from './types.js';
	import { needsAnyProvider } from './zero-retention.js';

	let settings = $state<AiSettings | null>(null);
	/** Models found by connection tests, per provider, for the model pickers. */
	let models = $state<Record<string, string[]>>({});
	/** Per provider, the models some provider serves without keeping data, when the test said. */
	let zeroRetentionModels = $state<Record<string, ReadonlySet<string>>>({});
	const zeroRetention = $derived(settings?.privacy.zeroRetention ?? false);
	const needsOff = (providerId: string, model: string) =>
		needsAnyProvider(model, zeroRetentionModels[providerId], zeroRetention);
	let error = $state<string | null>(null);
	let roles = $state<Roles>({
		fast: null,
		vision: null,
		smart: null,
		transcribe: null,
		embed: null,
	});
	let perTask = $state(false);

	/** Whether the three chat tasks use one provider and model (or none is set yet). */
	function sameForChat(r: Roles): boolean {
		const set = CHAT_ROLES.map((role) => r[role]).filter(Boolean);
		if (set.length === 0) return true;
		const [first] = set;
		return (
			set.length === CHAT_ROLES.length &&
			set.every((v) => v?.providerId === first?.providerId && v?.model === first?.model)
		);
	}

	async function load() {
		settings = (await api.GET('/api/v1/ai/settings')).data ?? null;
		if (settings) {
			roles = $state.snapshot(settings.roles) as Roles;
			// One model for everything until the family chose different ones per task.
			perTask = !sameForChat(roles);
		}
	}
	$effect(() => {
		if (session.can('core.ai.manage')) void load();
	});

	// The provider panel lives in the address: ?new=1 or ?edit=<id>.
	const editId = $derived(page.url.searchParams.get('edit'));
	const adding = $derived(page.url.searchParams.has('new'));
	const editing = $derived(settings?.providers.find((p) => p.id === editId) ?? null);
	const panelOpen = $derived(adding || editing !== null);
	const here = $derived(page.url.pathname);
	const openPanel = (query: string) => void goto(`${here}?${query}`, { reset: false });

	/** Simple mode: the one choice is kept in "smart" and copied to the other chat tasks on save. */
	const main = $derived(roles.smart ?? roles.fast ?? roles.vision);
	function setMainProvider(providerId: string) {
		for (const r of CHAT_ROLES)
			roles[r] = providerId ? { providerId, model: main?.model ?? '' } : null;
	}
	function setMainModel(model: string) {
		for (const r of CHAT_ROLES) {
			const v = roles[r];
			if (v) roles[r] = { ...v, model };
		}
	}
	function setProvider(role: Role, providerId: string) {
		roles[role] = providerId ? { providerId, model: roles[role]?.model ?? '' } : null;
	}

	async function saveRoles() {
		error = null;
		if (!perTask && main) for (const r of CHAT_ROLES) roles[r] = { ...main };
		const clean = Object.fromEntries(
			ROLES.map((r) => {
				const v = roles[r];
				return [
					r,
					v && v.model.trim() ? { providerId: v.providerId, model: v.model.trim() } : null,
				];
			}),
		) as Roles;
		try {
			unwrap(await api.PUT('/api/v1/ai/roles', { body: clean }));
			toasts.show(t('ai_saved'));
			await load();
		} catch {
			error = t('error_generic');
		}
	}

	const providerIcon = (p: Provider) =>
		p.kind === 'ollama' ? HardDrive : p.kind === 'openrouter' ? Cloud : Server;
</script>

{#snippet modelPicker(role: Role | 'main', choice: { providerId: string; model: string } | null)}
	<div class="grid gap-2">
		<SelectField
			aria-label={t('ai_provider')}
			value={choice?.providerId ?? ''}
			onchange={(e) =>
				role === 'main'
					? setMainProvider(e.currentTarget.value)
					: setProvider(role, e.currentTarget.value)}
		>
			<option value="">{t('ai_not_set')}</option>
			{#each settings?.providers ?? [] as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
		</SelectField>
		{#if choice}
			<Combobox
				id="model-{role}"
				aria-label={t('ai_model')}
				value={choice.model}
				onpick={(m) =>
					role === 'main' ? setMainModel(m) : (roles[role] = { ...choice, model: m })}
				onchange={(m) =>
					role === 'main' ? setMainModel(m) : (roles[role] = { ...choice, model: m })}
				options={(models[choice.providerId] ?? []).map((m) => ({
					value: m,
					...(needsOff(choice.providerId, m) && { label: t('ai_model_needs_any_provider') }),
				}))}
				placeholder={t('ai_model_placeholder')}
			/>
			{#if needsOff(choice.providerId, choice.model)}
				<p class="text-attention text-xs" data-testid="model-needs-any-provider">
					{t('ai_model_needs_any_provider_hint')}
					<a href="/settings/ai/privacy" class="underline underline-offset-4"
						>{t('nav_ai_privacy')}</a
					>
				</p>
			{/if}
		{/if}
	</div>
{/snippet}

<Page template="settings">
	<PageHeader title={t('nav_ai')}>
		{#snippet actions()}
			{#if settings && settings.providers.length > 0}
				<Button onclick={saveRoles}>{t('ai_save')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if settings}
		<div class="grid gap-7">
			{#if error}<Notice tone="alert">{error}</Notice>{/if}

			{#if settings.providers.length === 0}
				<EmptyState art="assistant" title={t('ai_no_providers')} hint={t('ai_privacy')}>
					<Button onclick={() => openPanel('new=1')}><Plus />{t('ai_add_provider')}</Button>
				</EmptyState>
			{:else}
				<Section label={t('ai_providers')} count={settings.providers.length}>
					{#snippet actions()}
						<Button variant="ghost" onclick={() => openPanel('new=1')}
							><Plus />{t('ai_add_provider')}</Button
						>
					{/snippet}
					<Card rows>
						{#each settings.providers as provider (provider.id)}
							{@const Icon = providerIcon(provider)}
							<Row
								title={provider.name}
								meta={`${tDynamic(`app:ai_kind_${provider.kind}`)} · ${provider.baseUrl}`}
								onclick={() => openPanel(`edit=${provider.id}`)}
							>
								{#snippet lead()}
									<span class="bg-idle text-ink-soft grid size-9 place-items-center rounded-full">
										<Icon size={18} aria-hidden="true" />
									</span>
								{/snippet}
								{#snippet trail()}
									{#if provider.local}<Pill tone="now">{t('ai_provider_local')}</Pill>{/if}
									{#if provider.hasKey && !provider.keyReadable}
										<Pill tone="attention">{t('ai_key_unreadable')}</Pill>
									{/if}
									<ChevronRight size={18} class="text-ink-soft" aria-hidden="true" />
								{/snippet}
							</Row>
						{/each}
					</Card>
					<Notice>{t('ai_privacy')}</Notice>
				</Section>

				<Section label={t('ai_roles')}>
					<p class="text-ink-soft max-w-prose text-sm">{t('ai_roles_intro')}</p>
					<Card rows>
						{#if perTask}
							{#each CHAT_ROLES as role (role)}
								<div data-testid="ai-role-{role}">
									<SettingRow
										label={tDynamic(`app:ai_role_${role}`)}
										hint={tDynamic(`app:ai_role_${role}_hint`)}
									>
										{#snippet control()}{@render modelPicker(role, roles[role])}{/snippet}
									</SettingRow>
								</div>
							{/each}
						{:else}
							<div data-testid="ai-role-main">
								<SettingRow label={t('ai_main_model')} hint={t('ai_main_model_hint')}>
									{#snippet control()}{@render modelPicker('main', main)}{/snippet}
								</SettingRow>
							</div>
						{/if}
						<SwitchRow id="ai-per-task" label={t('ai_per_task')} bind:checked={perTask} />
						{#each ['transcribe', 'embed'] as const as role (role)}
							<div data-testid="ai-role-{role}">
								<SettingRow
									label={t('ai_role_optional', { name: tDynamic(`app:ai_role_${role}`) })}
									hint={tDynamic(`app:ai_role_${role}_hint`)}
								>
									{#snippet control()}{@render modelPicker(role, roles[role])}{/snippet}
								</SettingRow>
							</div>
						{/each}
					</Card>
				</Section>
			{/if}
		</div>
	{/if}

	<ProviderPanel
		open={panelOpen}
		provider={adding ? null : editing}
		onclose={() => void goto(here, { replace: true, reset: false })}
		onchanged={load}
		onmodels={(id, list, kept) => {
			models[id] = list;
			if (kept) zeroRetentionModels[id] = new Set(kept);
			else delete zeroRetentionModels[id];
		}}
	/>
</Page>
