<script lang="ts">
	import { Card, Notice, Row, Section, SidePanel } from '@famos/ui/famos';
	import { BadgeCheck, Download } from '@lucide/svelte';
	import { numberFormat } from '#lib/format.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import { type Entry, type FoundPackage, reachOfFound } from './entries.js';
	import ReachRows from './ReachRows.svelte';

	/**
	 * A package the official index lists: what it is for, its version and its size, and Download
	 * as the panel's one action. What it reaches comes from the signed index and is shown before
	 * the download; the server checks the downloaded package says the same, and the panel of a
	 * file to install then takes over.
	 */
	let {
		pkg,
		update,
		list,
		name,
		names,
		description,
		downloading,
		problem,
		ondownload,
		onclose,
	}: {
		pkg: FoundPackage | null;
		/** It updates an installed extension (else it is new here). */
		update: boolean;
		/** The extensions the server lists, for what installs along with it. */
		list: readonly Entry[];
		name: string;
		names: (ids: readonly string[]) => string;
		description: string;
		downloading: boolean;
		/** Why the last download failed, in the page's words. */
		problem: { text: string; detail?: string } | null;
		ondownload: (pkg: FoundPackage) => void;
		onclose: () => void;
	} = $props();

	const reach = $derived(pkg ? reachOfFound(pkg, list) : null);
	/** What it needs that is already there (what is not comes along, said by its rows). */
	const needs = $derived(reach ? reach.needs.filter((id) => !reach.alongside.includes(id)) : []);

	const megabytes = (bytes: number) =>
		numberFormat({ style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(
			bytes / 1048576,
		);
</script>

<SidePanel
	open={pkg !== null}
	title={name}
	closeLabel={t('side_panel_close')}
	cancelLabel={t('cancel')}
	saveLabel={reach ? t('extensions_download_check') : t('extensions_download')}
	onsave={() => pkg && ondownload(pkg)}
	saveDisabled={downloading}
	{onclose}
>
	{#if pkg}
		<div class="grid gap-6" data-testid="found-panel">
			<div class="grid gap-1">
				{#if description}<p class="max-w-prose">{description}</p>{/if}
				<p class="text-ink-soft text-[13px]">
					{update && pkg.current
						? t('extensions_updates_from', { from: pkg.current, to: pkg.version })
						: t('extensions_version', { version: pkg.version })}
				</p>
			</div>

			<Section label={t('extensions_signer')}>
				<Card rows>
					<Row
						wrap
						title={t('extensions_found_official')}
						meta={reach
							? t('extensions_found_official_reach_hint')
							: t('extensions_found_official_hint')}
					>
						{#snippet lead()}<BadgeCheck class="size-5" aria-hidden="true" />{/snippet}
					</Row>
					<Row
						wrap
						title={t('extensions_download_size', { size: megabytes(pkg.size) })}
						meta={t('extensions_download_hint')}
					>
						{#snippet lead()}<Download class="size-5" aria-hidden="true" />{/snippet}
					</Row>
				</Card>
			</Section>

			{#if reach}
				<ReachRows {reach} {needs} {names} showAlongside />
			{/if}

			{#if downloading}
				<Notice>{t('extensions_downloading')}</Notice>
			{:else if problem}
				<Notice tone="alert">
					{problem.text}
					{#if problem.detail}
						<span class="text-ink-soft mt-1 block text-[13px] break-words">{problem.detail}</span>
					{/if}
				</Notice>
			{/if}
		</div>
	{/if}
</SidePanel>
