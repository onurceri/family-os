<script lang="ts">
	import { Card, Row, Section } from '@famos/ui/famos';
	import {
		Blocks,
		Database,
		Globe,
		House,
		KeyRound,
		Link,
		PackagePlus,
		Shield,
	} from '@lucide/svelte';
	import { t } from '#lib/i18n.svelte.js';
	import { type Reach, staysInside } from './entries.js';

	/**
	 * What an extension reaches beyond its own data, as rows: shown before it is installed (from
	 * its package or from the signed index) and while it is there.
	 */
	let {
		reach,
		needs,
		names,
		showAlongside,
		dataKept = false,
	}: {
		reach: Reach;
		/** What it needs that is already there. */
		needs: readonly string[];
		names: (ids: readonly string[]) => string;
		/** Say what installs along with it (it is not installed yet). */
		showAlongside: boolean;
		/** Say its data stays when it is uninstalled (it is installed or switched off). */
		dataKept?: boolean;
	} = $props();
</script>

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
			<Row wrap title={t('extensions_reach_user_urls')} meta={t('extensions_reach_user_urls_hint')}>
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
		{#if showAlongside && reach.alongside.length > 0}
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
		{#if dataKept}
			<Row wrap title={t('extensions_reach_data')} data-testid="extension-data">
				{#snippet lead()}<Database class="size-5" aria-hidden="true" />{/snippet}
			</Row>
		{/if}
	</Card>
</Section>
