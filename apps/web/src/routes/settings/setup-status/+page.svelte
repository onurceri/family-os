<script lang="ts">
	import { useApp } from '@famos/ui/app';
	import { Button } from '@famos/ui/button';
	import { Card, Notice, Page, PageHeader, Pill, Row, Section } from '@famos/ui/famos';
	import { Check, CircleAlert } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { facetsOf } from '#lib/contributions.js';
	import { contributions } from '#lib/extensions.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import {
		coreChecks,
		hintChecks,
		type SetupCheck,
		type SetupFacts,
		splitChecks,
	} from '#lib/setup-status.js';

	/**
	 * Settings, System, Setup status: what the family has set up and what is still missing, one row
	 * per check. It only reads; each button goes to the page where the check is put right.
	 */
	const app = useApp();
	let facts = $state<SetupFacts | null>(null);
	let hintDone = $state<Record<string, boolean>>({});
	let hintsLoaded = $state(false);

	// The steps extensions add to Today's first steps, the same ones, for those who may do them.
	const hints = $derived(
		facetsOf(contributions.facets, 'setupHint', {
			can: (capability) => session.can(capability),
			disabledExtensions: session.disabledExtensions,
		}).toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0)),
	);

	async function load() {
		facts = (await api.GET('/api/v1/core/setup-checks')).data ?? null;
		const answers = await Promise.all(
			hints.map((hint) =>
				hint
					.load(app)
					// A step that cannot be read is not reported as missing.
					.catch(() => true)
					.then((done) => [hint.id, done] as const),
			),
		);
		hintDone = Object.fromEntries(answers);
		hintsLoaded = true;
	}
	$effect(() => {
		if (session.can('core.settings.manage')) void load();
	});

	const checks = $derived<SetupCheck[]>(
		facts
			? [
					...coreChecks(facts, window.isSecureContext),
					...hintChecks(
						hints.map((h) => ({ ...h })),
						hintDone,
					),
				]
			: [],
	);
	const parts = $derived(splitChecks(checks));
	const mayOpen = (check: SetupCheck) => !check.requires || session.can(check.requires);
</script>

{#snippet rows(list: SetupCheck[])}
	<Card rows>
		{#each list as check (check.id)}
			<Row
				wrap
				title={tDynamic(check.titleKey)}
				meta={check.done || !check.breaksKey
					? tDynamic(check.textKey)
					: `${tDynamic(check.textKey)} ${tDynamic(check.breaksKey)}`}
				data-testid="setup-check"
				data-check={check.id}
				data-done={check.done}
			>
				{#snippet lead()}
					{#if check.done}
						<Check size={18} class="text-now" aria-hidden="true" />
					{:else}
						<CircleAlert size={18} class="text-attention" aria-hidden="true" />
					{/if}
				{/snippet}
				{#snippet trail()}
					<Pill tone={check.done ? 'now' : 'attention'}>
						{check.done ? t('setup_status_done') : t('setup_status_missing')}
					</Pill>
					{#if !check.done && mayOpen(check)}
						<Button
							variant="outline"
							size="sm"
							href={check.href}
							{...check.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}}
							>{tDynamic(check.actionKey)}</Button
						>
					{/if}
				{/snippet}
			</Row>
		{/each}
	</Card>
{/snippet}

<Page template="settings">
	<PageHeader title={t('setup_status_title')} subtitle={t('setup_status_intro')} />

	<div class="grid min-w-0 gap-7 [overflow-wrap:anywhere]">
		{#if facts && hintsLoaded}
			{#if parts.missing.length === 0}
				<Notice>{t('setup_status_all_done')}</Notice>
			{:else}
				<Section label={t('setup_status_missing_section')} count={parts.missing.length}>
					{@render rows(parts.missing)}
				</Section>
			{/if}
			{#if parts.done.length > 0}
				<Section label={t('setup_status_done_section')} count={parts.done.length}>
					{@render rows(parts.done)}
				</Section>
			{/if}
		{/if}
	</div>
</Page>
