<script lang="ts">
	import { Card, Notice, Row, Section, SidePanel } from '@famos/ui/famos';
	import {
		BadgeCheck,
		Blocks,
		Globe,
		House,
		KeyRound,
		Link,
		PackagePlus,
		Shield,
	} from '@lucide/svelte';
	import { t } from '#lib/i18n.svelte.js';
	import { type Entry, reachOf, type Staged, staysInside, updateOf } from './entries.js';

	/**
	 * One extension's details: what it is for and what it reaches beyond its own data, so a family
	 * knows before it installs. An available one has Install as the panel's one action; an
	 * installed one is only read here (its switch and its menu are on the row). A package from a
	 * file (`staged`) also says who signed it and which version it replaces.
	 */
	let {
		entry,
		list,
		name,
		description,
		busy,
		error,
		staged = null,
		oninstall,
		onclose,
	}: {
		entry: Entry | null;
		list: readonly Entry[];
		name: (entry: Entry) => string;
		description: (entry: Entry) => string;
		busy: boolean;
		error: string | null;
		staged?: Staged | null;
		oninstall: (entry: Entry) => void;
		onclose: () => void;
	} = $props();

	const reach = $derived(entry ? reachOf(entry, list) : null);
	const names = (ids: readonly string[]) =>
		ids
			.map((id) => {
				const other = list.find((e) => e.id === id);
				return other ? name(other) : id;
			})
			.join(', ');
	/** What it needs that is already there (what is not comes along, said above). */
	const needs = $derived(
		reach && entry
			? reach.needs.filter((id) => entry.status !== 'available' || !reach.alongside.includes(id))
			: [],
	);
	const update = $derived(staged ? updateOf(staged) : null);
	const leftOut = $derived(entry?.status === 'refused' || entry?.status === 'failed');
</script>

<SidePanel
	open={entry !== null}
	title={entry ? name(entry) : ''}
	closeLabel={t('side_panel_close')}
	cancelLabel={t('cancel')}
	saveLabel={update ? t('extensions_update') : t('extensions_install')}
	onsave={entry?.status === 'available' ? () => entry && oninstall(entry) : undefined}
	saveDisabled={busy}
	{onclose}
>
	{#if entry && reach}
		<div class="grid gap-6" data-testid="extension-panel">
			<div class="grid gap-1">
				{#if description(entry)}<p class="max-w-prose">{description(entry)}</p>{/if}
				{#if entry.version}
					<p class="text-ink-soft text-[13px]">
						{update
							? t('extensions_updates_from', { from: update.from, to: update.to })
							: t('extensions_version', { version: entry.version })}
					</p>
				{/if}
			</div>

			{#if staged}
				<Section label={t('extensions_signer')}>
					<Card rows>
						<Row
							wrap
							title={staged.signer.kind === 'official'
								? t('extensions_signed_official')
								: t('extensions_signed_key', { keyId: staged.signer.keyId })}
							meta={t('extensions_signed_hint', { keyId: staged.signer.keyId })}
							data-testid="extension-signer"
						>
							{#snippet lead()}<BadgeCheck class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					</Card>
				</Section>
			{/if}

			{#if leftOut}
				<Section label={t('extensions_why')}>
					<Notice tone="warn">
						{entry.status === 'failed'
							? t('extensions_status_failed')
							: t('extensions_status_refused')}
						{#if entry.reason}
							<span class="text-ink-soft mt-1 block text-[13px] break-words">{entry.reason}</span>
						{/if}
					</Notice>
				</Section>
			{/if}

			<Section label={t('extensions_reaches')}>
				<Card rows>
					{#if staysInside(reach)}
						<Row wrap title={t('extensions_reach_inside')} meta={t('extensions_reach_inside_hint')}>
							{#snippet lead()}<Shield class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
					{#if reach.hosts.length > 0}
						<Row wrap title={t('extensions_reach_hosts')} meta={reach.hosts.join(', ')}>
							{#snippet lead()}<Globe class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
					{#if reach.userUrls}
						<Row
							wrap
							title={t('extensions_reach_user_urls')}
							meta={t('extensions_reach_user_urls_hint')}
						>
							{#snippet lead()}<Link class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
					{#if reach.local}
						<Row wrap title={t('extensions_reach_local')} meta={t('extensions_reach_local_hint')}>
							{#snippet lead()}<House class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
					{#if reach.capabilities > 0}
						<Row
							wrap
							title={t('extensions_reach_capabilities', { count: reach.capabilities })}
							meta={t('extensions_reach_capabilities_hint')}
						>
							{#snippet lead()}<KeyRound class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
					{#if entry.status === 'available' && reach.alongside.length > 0}
						<Row
							wrap
							title={t('extensions_alongside', { names: names(reach.alongside) })}
							meta={t('extensions_alongside_hint')}
							data-testid="extension-alongside"
						>
							{#snippet lead()}<PackagePlus class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
					{#if needs.length > 0}
						<Row
							wrap
							title={t('extensions_needs', { names: names(needs) })}
							meta={t('extensions_needs_hint')}
						>
							{#snippet lead()}<Blocks class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
					{#if reach.worksWith.length > 0}
						<Row
							wrap
							title={t('extensions_works_with', { names: names(reach.worksWith) })}
							meta={t('extensions_works_with_hint')}
						>
							{#snippet lead()}<Blocks class="size-5" aria-hidden="true" />{/snippet}
						</Row>
					{/if}
				</Card>
			</Section>
			{#if error}<Notice tone="alert">{error}</Notice>{/if}
		</div>
	{/if}
</SidePanel>
