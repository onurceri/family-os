<script lang="ts">
	import { dateTimeFormat, numberFormat } from '#lib/format.svelte.js';
	import { Button } from '@famos/ui/button';
	import { Card, Notice, Page, PageHeader, Section } from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { contributions, enabledOnly } from '#lib/extensions.js';
	import { getLocale, t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import type { ActivityEntry } from '../types.js';

	/** Every model call, newest first. Only metadata exists: never what was said. */
	let entries = $state<ActivityEntry[]>([]);
	let next = $state<string | null>(null);
	let loaded = $state(false);
	let loading = $state(false);

	async function load(before?: string) {
		loading = true;
		try {
			const page = (
				await api.GET('/api/v1/ai/activity', {
					params: { query: { limit: 30, ...(before && { before }) } },
				})
			).data;
			if (page) {
				entries = before ? [...entries, ...page.entries] : page.entries;
				next = page.next;
			}
		} finally {
			loading = false;
			loaded = true;
		}
	}
	$effect(() => {
		if (session.can('core.ai.manage')) void load();
	});

	const features = $derived(
		new Map(
			enabledOnly(contributions.extensions, [])
				.flatMap((e) => e.aiFeatures ?? [])
				.map((f) => [f.id, f.labelKey]),
		),
	);
	const featureLabel = (id: string) => {
		if (id === 'mcp') return t('mcp_feature_label');
		const key = features.get(id);
		return key ? tDynamic(key) : id;
	};
	const areaLabel = (id: string) => {
		const key = contributions.extension(id)?.labelKey;
		return key ? tDynamic(key) : id;
	};
	const known = new Set([
		'disabled',
		'local_required',
		'limit_reached',
		'auth',
		'not_configured',
		'data_policy',
		'rejected',
		'timeout',
		'unavailable',
		'invalid_output',
		'output_too_long',
	]);
	const result = (code: string | null) =>
		code === null
			? t('ai_activity_ok')
			: tDynamic(`app:ai_activity_err_${known.has(code) ? code : 'other'}`);

	const when = (ms: number) =>
		dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(ms);
	const usd = $derived(
		numberFormat({
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 4,
		}),
	);
	const cost = (value: number | null) =>
		value === null
			? t('ai_activity_cost_unknown')
			: value === 0
				? t('ai_activity_free')
				: usd.format(value);
</script>

<Page template="settings">
	<PageHeader title={t('ai_activity_title')} subtitle={t('ai_activity_intro')} />

	<p class="mb-4">
		<a class="text-ink font-semibold underline" href="/settings/ai/usage">{t('ai_activity_back')}</a
		>
	</p>

	{#if loaded && entries.length === 0}
		<Notice>{t('ai_activity_none')}</Notice>
	{:else}
		<Section label={t('ai_activity_title')}>
			<Card>
				<ul class="divide-line divide-y" data-testid="ai-activity">
					{#each entries as entry (entry.id)}
						<li class="grid gap-1.5 px-4 py-3" data-testid="ai-activity-entry">
							<div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
								<b>{featureLabel(entry.feature)}</b>
								<span class="text-ink-soft text-sm">{when(entry.at)}</span>
								{#if entry.member}
									<span class="text-ink-soft text-sm"
										>{t('ai_activity_for', { name: entry.member })}</span
									>
								{/if}
							</div>
							<div class="flex flex-wrap items-center gap-1.5" aria-label={t('ai_activity_areas')}>
								<span class="text-ink-soft text-xs">{t('ai_activity_areas')}:</span>
								{#if entry.areas === null}
									<span class="text-ink-soft text-xs">{t('ai_activity_areas_unknown')}</span>
								{:else if entry.areas.length === 0}
									<span class="text-ink-soft text-xs">{t('ai_activity_areas_none')}</span>
								{:else}
									{#each entry.areas as area (area)}
										<span class="bg-idle rounded-full px-2.5 py-0.5 text-xs font-semibold"
											>{areaLabel(area)}</span
										>
									{/each}
								{/if}
							</div>
							<div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
								<span class="text-ink-soft"
									>{entry.provider ? `${entry.provider} / ${entry.model}` : entry.model}</span
								>
								<span class="text-ink-soft tabular-nums">{cost(entry.cost)}</span>
								{#if entry.inputTokens !== null || entry.outputTokens !== null}
									<span class="text-ink-soft tabular-nums" data-testid="ai-activity-tokens"
										>{t('ai_activity_tokens', {
											input: entry.inputTokens ?? 0,
											output: entry.outputTokens ?? 0,
										})}{entry.reasoningTokens
											? ` ${t('ai_activity_thinking', { count: entry.reasoningTokens })}`
											: ''}{entry.finishReason === 'length'
											? ` ${t('ai_activity_cut_off')}`
											: ''}</span
									>
								{/if}
								<span class={entry.errorCode ? 'text-attention font-semibold' : 'text-ink-soft'}
									>{result(entry.errorCode)}</span
								>
							</div>
						</li>
					{/each}
				</ul>
			</Card>
			{#if next}
				<div>
					<Button variant="outline" disabled={loading} onclick={() => next && load(next)}
						>{t('ai_activity_older')}</Button
					>
				</div>
			{/if}
		</Section>
	{/if}
</Page>
