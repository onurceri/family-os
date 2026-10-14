<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Card, Dialog, Notice, Section, Segmented, SettingRow } from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { contributions } from '#lib/extensions.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import { AREA_ACCESS, type AiArea, type AiAreaAccess } from './types.js';

	/** Per area (extension): how far the AI may use it. Each choice saves at once. */
	let areas = $state<AiArea[]>([]);
	let error = $state<string | null>(null);
	/** A sensitive area waiting for the "send my data to any provider" confirmation. */
	let confirming = $state<AiArea | null>(null);
	/** Bumped to put a choice back (a segmented control keeps what was tapped until told otherwise). */
	let reset = $state(0);
	/** Family search: set up, and the areas it reads. */
	let search = $state<{
		configured: boolean;
		error: string | null;
		areas: { id: string; covered: boolean }[];
	} | null>(null);
	const notCovered = (id: string) =>
		search?.configured === true && search.areas.some((a) => a.id === id && !a.covered);

	const web = (id: string) => contributions.extension(id);
	const nameOf = (area: AiArea) => {
		const key = web(area.id)?.labelKey;
		return key ? tDynamic(key) : area.id;
	};
	// Areas turned off in More → Features are hidden, and so are extensions without a name.
	const shown = $derived(
		areas.filter(
			(a) =>
				!session.disabledExtensions.includes(a.id) &&
				// Only areas the AI can do something in (or that hold sensitive data).
				(a.sensitive || a.usesAi || (web(a.id)?.aiFeatures?.length ?? 0) > 0),
		),
	);

	async function load() {
		areas = (await api.GET('/api/v1/core/ai-areas')).data ?? [];
		search = (await api.GET('/api/v1/core/search/status')).data ?? null;
	}
	$effect(() => {
		if (!session.can('core.ai.manage')) return;
		void load();
		return onEvent('core.aiAreas.', () => void load());
	});

	async function save(area: AiArea, access: AiAreaAccess, confirmSensitive = false) {
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.setAiAreaAccess', {
					body: { extensionId: area.id, access, ...(confirmSensitive && { confirmSensitive }) },
				}),
			);
			confirming = null;
			toasts.show(t('ai_saved'));
		} catch {
			error = t('error_generic');
		}
		await load();
	}

	function choose(area: AiArea, access: string) {
		const next = access as AiAreaAccess;
		if (next === area.access) return;
		if (next === 'any' && area.sensitive) {
			confirming = area;
			reset++;
		} else void save(area, next);
	}

	/** One line under the name: what is special about the area, or what it falls back to. */
	function hint(area: AiArea): string {
		const parts: string[] = [];
		if (area.sensitive) parts.push(`${t('ai_area_sensitive')}. ${t('ai_area_sensitive_hint')}`);
		else if (area.access !== area.default)
			parts.push(t('ai_area_default_is', { name: tDynamic(`app:ai_area_${area.default}`) }));
		if (notCovered(area.id) && area.access !== 'off') parts.push(t('ai_area_search_not_covered'));
		return parts.join(' ');
	}
</script>

{#if shown.length > 0}
	<Section label={t('ai_areas_title')}>
		<p class="text-ink-soft max-w-prose text-sm">{t('ai_areas_intro')}</p>
		<Card rows>
			{#each shown as area (area.id)}
				<div data-testid="ai-area-{area.id}">
					<SettingRow label={nameOf(area)} hint={hint(area) || undefined}>
						{#snippet control()}
							{#key reset}
								<Segmented
									label={nameOf(area)}
									grow
									size="sm"
									value={area.access}
									onchange={(v) => choose(area, v)}
									options={AREA_ACCESS.map((access) => ({
										value: access,
										label: tDynamic(`app:ai_area_${access}`),
									}))}
								/>
							{/key}
						{/snippet}
					</SettingRow>
				</div>
			{/each}
		</Card>
		<p class="text-ink-soft max-w-prose text-[13px]">{t('ai_area_local_hint')}</p>
		{#if search?.error}<Notice tone="warn">{t('ai_search_error')}</Notice>{/if}
		{#if error}<Notice tone="alert">{error}</Notice>{/if}
	</Section>
{/if}

<Dialog
	open={confirming !== null}
	title={t('ai_area_confirm_yes')}
	description={t('ai_area_confirm')}
	onclose={() => (confirming = null)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (confirming = null)}
			>{t('ai_cancel')}</Button
		>
		<Button variant="primary" onclick={() => confirming && save(confirming, 'any', true)}
			>{t('ai_area_confirm_yes')}</Button
		>
	{/snippet}
</Dialog>
