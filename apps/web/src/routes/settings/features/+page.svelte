<script lang="ts">
	import { goto } from '$app/navigation';
	import { type paths, unwrap } from '@famos/api-client';
	import { Card, Page, PageHeader, Section, SwitchRow } from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { contributions } from '#lib/extensions.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';

	type Feature =
		paths['/api/v1/core/features']['get']['responses'][200]['content']['application/json'][number];

	let features = $state<Feature[]>([]);
	let error = $state<string | null>(null);
	const web = (id: string) => contributions.extension(id);
	async function load() {
		features = (await api.GET('/api/v1/core/features')).data ?? [];
	}

	$effect(() => {
		if (session.status === 'ready' && !session.can('core.features.manage'))
			void goto('/', { replaceState: true });
	});
	$effect(() => {
		if (!session.can('core.features.manage')) return;
		void load();
		return onEvent('core.features.', () => void load());
	});

	async function toggle(extensionId: string, enabled: boolean) {
		error = null;
		try {
			unwrap(
				await api.POST('/api/v1/actions/core.setFeatureEnabled', {
					body: { extensionId, enabled },
				}),
			);
			toasts.show(enabled ? t('features_turned_on') : t('features_turned_off'));
			await Promise.all([load(), session.refresh()]);
		} catch {
			error = t('error_generic');
			await load();
		}
	}
</script>

<Page template="settings">
	<PageHeader title={t('features_title')} subtitle={t('features_intro')} />

	<div class="grid gap-3">
		{#if error}<p class="text-attention font-semibold" role="alert">{error}</p>{/if}
		<Section label={t('features_extensions')} count={features.filter((f) => f.canDisable).length}>
			<Card rows>
				{#each features.filter((f) => f.canDisable) as feature (feature.id)}
					{@const ext = web(feature.id)}
					<SwitchRow
						id="feature-{feature.id}"
						label={ext?.labelKey ? tDynamic(ext.labelKey) : feature.id}
						hint={ext?.descriptionKey ? tDynamic(ext.descriptionKey) : undefined}
						checked={feature.enabled}
						onchange={(enabled) => toggle(feature.id, enabled)}
					/>
				{/each}
			</Card>
		</Section>
		<p class="text-ink-soft max-w-prose px-1 text-[13px]">{t('features_data_kept')}</p>
	</div>
</Page>
