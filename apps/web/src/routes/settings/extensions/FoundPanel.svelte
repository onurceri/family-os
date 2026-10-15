<script lang="ts">
	import { Card, Notice, Row, Section, SidePanel } from '@famos/ui/famos';
	import { BadgeCheck, Download } from '@lucide/svelte';
	import { numberFormat } from '#lib/format.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import type { FoundPackage } from './entries.js';

	/**
	 * A package the official index lists: what it is for, its version and its size, and Download
	 * as the panel's one action. What it reaches is shown once the server has downloaded and
	 * checked it, when the panel of a file to install takes over.
	 */
	let {
		pkg,
		update,
		name,
		description,
		downloading,
		problem,
		ondownload,
		onclose,
	}: {
		pkg: FoundPackage | null;
		/** It updates an installed extension (else it is new here). */
		update: boolean;
		name: string;
		description: string;
		downloading: boolean;
		/** Why the last download failed, in the page's words. */
		problem: { text: string; detail?: string } | null;
		ondownload: (pkg: FoundPackage) => void;
		onclose: () => void;
	} = $props();

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
	saveLabel={t('extensions_download')}
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
						meta={t('extensions_found_official_hint')}
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
