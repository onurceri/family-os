<script lang="ts">
	import { numberFormat } from '#lib/format.svelte.js';

	import { Button } from '@famos/ui/button';
	import { Card, Facts, Notice, Page, PageHeader, Row, Section, SettingRow } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { ChevronRight } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { runAction } from '#lib/run-action.js';
	import { t } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import type { AiSettings, Usage } from '../types.js';

	let settings = $state<AiSettings | null>(null);
	let usage = $state<Usage | null>(null);
	let error = $state<string | null>(null);
	let limits = $state({ cost: '', calls: '' });

	async function load() {
		const [s, u] = await Promise.all([api.GET('/api/v1/ai/settings'), api.GET('/api/v1/ai/usage')]);
		settings = s.data ?? null;
		usage = u.data ?? null;
		if (settings)
			limits = {
				cost: settings.limits.monthlyCostLimit?.toString() ?? '',
				calls: settings.limits.monthlyCallLimit?.toString() ?? '',
			};
	}
	$effect(() => {
		if (session.can('core.ai.manage')) void load();
	});

	async function saveLimits(event: SubmitEvent) {
		event.preventDefault();
		error = null;
		const num = (s: string) => (s.trim() ? Number(s.replace(',', '.')) : null);
		await runAction(
			api.POST('/api/v1/actions/core.setAiLimits', {
				body: { monthlyCostLimit: num(limits.cost), monthlyCallLimit: num(limits.calls) },
			}),
			{ saved: t('ai_saved'), onError: (failure) => (error = failure.message), reload: load },
		);
	}

	const nf = $derived(numberFormat());
	const usd = $derived(
		numberFormat({ style: 'currency', currency: 'USD', maximumFractionDigits: 4 }),
	);
</script>

<Page template="settings">
	<PageHeader title={t('nav_ai_usage')}>
		{#snippet actions()}
			<Button type="submit" form="ai-limits">{t('ai_save')}</Button>
		{/snippet}
	</PageHeader>

	{#if settings && usage}
		<div class="grid gap-7">
			{#if error}<Notice tone="alert">{error}</Notice>{/if}

			<Section label={t('ai_usage')}>
				{#if usage.total.calls === 0}
					<Notice>{t('ai_usage_none')}</Notice>
				{:else}
					<Facts
						label={t('ai_usage')}
						items={[
							{ label: t('ai_usage_calls'), value: nf.format(usage.total.calls) },
							{ label: t('ai_usage_errors'), value: nf.format(usage.total.errors) },
							{
								label: t('ai_usage_tokens'),
								value: nf.format(usage.total.inputTokens + usage.total.outputTokens),
							},
							{ label: t('ai_usage_cost'), value: usd.format(usage.total.cost) },
						]}
					/>
					{#if usage.byFeature.length > 0}
						<Card rows>
							{#each usage.byFeature as row (row.key)}
								<Row title={row.key}>
									{#snippet trail()}
										<span class="text-ink-soft text-[13px] tabular-nums"
											>{nf.format(row.calls)} · {usd.format(row.cost)}</span
										>
									{/snippet}
								</Row>
							{/each}
						</Card>
					{/if}
				{/if}
			</Section>

			<Section label={t('ai_limits')}>
				<p class="text-ink-soft max-w-prose text-sm">{t('ai_limits_intro')}</p>
				<form id="ai-limits" onsubmit={saveLimits}>
					<Card rows>
						<SettingRow label={t('ai_cost_limit')} for="cost-limit">
							{#snippet control()}
								<Input id="cost-limit" inputmode="decimal" bind:value={limits.cost} />
							{/snippet}
						</SettingRow>
						<SettingRow label={t('ai_call_limit')} for="call-limit">
							{#snippet control()}
								<Input id="call-limit" inputmode="numeric" bind:value={limits.calls} />
							{/snippet}
						</SettingRow>
					</Card>
				</form>
			</Section>

			<Section label={t('ai_related_title')}>
				<Card rows>
					<Row
						href="/settings/ai/activity"
						title={t('ai_activity_link')}
						meta={t('ai_activity_link_hint')}
						data-testid="ai-activity-link"
					>
						{#snippet trail()}<ChevronRight
								size={18}
								class="text-ink-soft"
								aria-hidden="true"
							/>{/snippet}
					</Row>
					<Row
						href="/settings/connected-apps"
						title={t('mcp_settings_link')}
						meta={t('mcp_settings_link_hint')}
						data-testid="mcp-link"
					>
						{#snippet trail()}<ChevronRight
								size={18}
								class="text-ink-soft"
								aria-hidden="true"
							/>{/snippet}
					</Row>
				</Card>
			</Section>
		</div>
	{/if}
</Page>
