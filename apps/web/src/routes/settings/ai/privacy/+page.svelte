<script lang="ts">
	import { goto } from '$app/navigation';
	import { unwrap } from '@famos/api-client';
	import { Card, Notice, Page, PageHeader, Section, SwitchRow } from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { contributions, enabledOnly } from '#lib/extensions.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import AreasSection from '../AreasSection.svelte';
	import type { AiSettings } from '../types.js';

	let settings = $state<AiSettings | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		if (session.status === 'ready' && !session.can('core.ai.manage'))
			void goto('/', { replaceState: true });
	});

	async function load() {
		settings = (await api.GET('/api/v1/ai/settings')).data ?? null;
	}
	$effect(() => {
		if (session.can('core.ai.manage')) void load();
	});

	// OpenRouter ignores provider routing for speech to text, so zero retention cannot be promised.
	const voiceHint = $derived.by(() => {
		const providerId = settings?.roles.transcribe?.providerId;
		const kind = settings?.providers.find((p) => p.id === providerId)?.kind;
		return kind === 'openrouter'
			? `${t('ai_privacy_voice_hint')} ${t('ai_privacy_voice_openrouter')}`
			: t('ai_privacy_voice_hint');
	});
	type Privacy = AiSettings['privacy'];
	async function savePrivacy(patch: Partial<Privacy>) {
		if (!settings) return;
		error = null;
		const next = { ...settings.privacy, ...patch };
		try {
			settings.privacy = unwrap(await api.PUT('/api/v1/ai/privacy', { body: next }));
			toasts.show(t('ai_saved'));
		} catch {
			error = t('error_generic');
			await load();
		}
	}

	// Switches: AI as a whole, and each AI feature of the extensions that are on.
	const aiFeatures = $derived(
		enabledOnly(contributions.extensions, session.disabledExtensions).flatMap(
			(e) => e.aiFeatures ?? [],
		),
	);
	async function saveSwitches(next: AiSettings['switches']) {
		if (!settings) return;
		error = null;
		try {
			settings.switches = unwrap(await api.PUT('/api/v1/ai/switches', { body: next }));
			toasts.show(t('ai_saved'));
		} catch {
			error = t('error_generic');
			await load();
		}
	}
	const setFeature = (id: string, on: boolean) => {
		if (!settings) return;
		const off = settings.switches.off.filter((f) => f !== id);
		void saveSwitches({ ...settings.switches, off: on ? off : [...off, id] });
	};
</script>

<Page template="settings">
	<PageHeader title={t('nav_ai_privacy')} />

	{#if settings}
		<div class="grid gap-7">
			{#if error}<Notice tone="alert">{error}</Notice>{/if}

			<Section label={t('ai_switch_title')}>
				<Card rows>
					<SwitchRow
						id="ai-main"
						label={t('ai_switch_main')}
						hint={t('ai_switch_main_hint')}
						checked={settings.switches.enabled}
						onchange={(enabled) => saveSwitches({ ...settings!.switches, enabled })}
					/>
					{#each aiFeatures as feature (feature.id)}
						<SwitchRow
							id="ai-feature-{feature.id}"
							label={tDynamic(feature.labelKey)}
							hint={feature.hintKey ? tDynamic(feature.hintKey) : undefined}
							checked={!settings.switches.off.includes(feature.id)}
							disabled={!settings.switches.enabled}
							onchange={(on) => setFeature(feature.id, on)}
						/>
					{/each}
				</Card>
			</Section>

			<Section label={t('ai_privacy_title')}>
				<Card rows>
					<SwitchRow
						id="privacy-files"
						label={t('ai_privacy_files')}
						hint={t('ai_privacy_files_hint')}
						checked={settings.privacy.sendFiles}
						onchange={(sendFiles) => savePrivacy({ sendFiles })}
					/>
					<SwitchRow
						id="privacy-people"
						label={t('ai_privacy_people')}
						hint={t('ai_privacy_people_hint')}
						checked={settings.privacy.sendPeople}
						onchange={(sendPeople) => savePrivacy({ sendPeople })}
					/>
					<SwitchRow
						id="privacy-voice"
						label={t('ai_privacy_voice')}
						hint={voiceHint}
						checked={settings.privacy.sendVoice}
						onchange={(sendVoice) => savePrivacy({ sendVoice })}
					/>
					<SwitchRow
						id="privacy-zdr"
						label={t('ai_privacy_zdr')}
						hint={t('ai_privacy_zdr_hint')}
						checked={settings.privacy.zeroRetention}
						onchange={(zeroRetention) => savePrivacy({ zeroRetention })}
					/>
				</Card>
			</Section>

			<AreasSection />
		</div>
	{/if}
</Page>
