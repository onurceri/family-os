<script lang="ts">
	/** Restoring runs on the server; the published guide says how. Nothing is fetched from it. */
	const RESTORE_GUIDE_URL =
		'https://github.com/onurceri/family-os/blob/main/docs/guide/backups.md#restore';
	const external = { target: '_blank', rel: 'noopener noreferrer' } as const;
	import { dateTimeFormat, numberFormat } from '#lib/format.svelte.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { Button } from '@famos/ui/button';
	import { Card, HelpTip, Notice, Page, PageHeader, Pill, Row, Section } from '@famos/ui/famos';
	import { ChevronRight, DatabaseBackup, FileKey, KeyRound, Plus } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { runAction } from '#lib/run-action.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';
	import EncryptionPanel from './EncryptionPanel.svelte';
	import KeyFileDialog from './KeyFileDialog.svelte';
	import { reason } from './reason.js';
	import TargetPanel from './TargetPanel.svelte';
	import type { BackupsData, Target } from './types.js';

	let data = $state<BackupsData | null>(null);
	let error = $state<string | null>(null);
	let running = $state(false);
	let savingKeyFile = $state(false);

	async function load() {
		data = (await api.GET('/api/v1/backups')).data ?? null;
	}
	$effect(() => {
		if (session.can('core.settings.manage')) void load();
	});

	// The panels live in the address: ?encryption=1, ?new=1 (a copy) and ?edit=<id>.
	const here = $derived(page.url.pathname);
	const encryptionOpen = $derived(page.url.searchParams.has('encryption'));
	const addingCopy = $derived(page.url.searchParams.has('new'));
	const editId = $derived(page.url.searchParams.get('edit'));
	const editing = $derived(data?.targets.find((x) => x.id === editId) ?? null);
	const openPanel = (query: string) => void goto(`${here}?${query}`, { reset: false });
	const closePanel = () => void goto(here, { replace: true, reset: false });

	const when = (ms: number) =>
		dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(ms);
	const megabytes = (bytes: number) =>
		numberFormat({ style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(
			bytes / 1048576,
		);

	async function runNow() {
		running = true;
		error = null;
		const known = new Set(data?.local.map((b) => b.name));
		const queued = await runAction(api.POST('/api/v1/actions/core.runBackup', { body: {} }), {
			saved: t('backups_run_queued'),
			onError: () => (error = t('backups_run_failed')),
		});
		if (queued.ok) {
			// The worker writes the backup in the background: look for it for a little while.
			for (let i = 0; i < 40; i++) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				await load();
				if (data?.local.some((b) => !known.has(b.name))) break;
			}
			// Uploads follow the backup; show their result when it arrives.
			for (let i = 0; i < 20; i++) {
				if (!data?.targets.some((x) => x.enabled && x.lastResult === null)) break;
				await new Promise((resolve) => setTimeout(resolve, 1500));
				await load();
			}
		}
		running = false;
	}

	/** The line under a copy's name: where it stands. `bad` means someone should look. */
	function status(target: Target): { text: string; bad: boolean } {
		if (!target.enabled) return { text: t('backups_status_paused'), bad: false };
		const result = target.lastResult;
		if (!result || target.lastRunAt === null)
			return { text: t('backups_status_never'), bad: false };
		if (result === 'ok')
			return {
				text: t('backups_status_ok', {
					time: when(target.lastRunAt),
					size: megabytes(target.lastSize ?? 0),
				}),
				bad: false,
			};
		if (result.startsWith('retrying_'))
			return { text: t('backups_status_retrying', { reason: reason(result) }), bad: true };
		return {
			text: t('backups_status_failed', { time: when(target.lastRunAt), reason: reason(result) }),
			bad: true,
		};
	}
</script>

<Page template="settings">
	<PageHeader title={t('backups_title')}>
		{#snippet actions()}
			<Button onclick={runNow} disabled={running}><DatabaseBackup />{t('backups_run')}</Button>
		{/snippet}
	</PageHeader>

	<div class="grid min-w-0 gap-7 [overflow-wrap:anywhere]">
		{#if error}<Notice tone="alert">{error}</Notice>{/if}

		{#if data}
			<Section label={t('backups_local_title')}>
				<ul class="text-ink-soft grid max-w-prose gap-0.5 text-sm">
					<li>
						{t('backups_schedule_nightly', { hour: data.schedule.hour, keep: data.schedule.keep })}
					</li>
					<li>{t('backups_schedule_update', { keep: data.schedule.keepBeforeUpdate })}</li>
					<li>{t('backups_schedule_manual')}</li>
				</ul>
				{#if data.local.length > 0}
					<Card rows>
						{#each data.local.slice(0, 8) as backup (backup.name)}
							<Row
								title={when(backup.createdAt)}
								meta={tDynamic(`app:backups_reason_${backup.reason}`)}
							>
								{#snippet trail()}
									<span class="text-ink-soft text-[13px] tabular-nums"
										>{megabytes(backup.size)}</span
									>
								{/snippet}
							</Row>
						{/each}
					</Card>
				{:else}
					<Notice>{t('backups_local_empty')}</Notice>
				{/if}
			</Section>

			<Section label={t('backups_enc_section')}>
				<Card>
					<Row
						wrap
						title={data.encryption.mode === 'unset'
							? t('backups_enc_unset_title')
							: tDynamic(`app:backups_enc_mode_${data.encryption.mode}`)}
						meta={data.encryption.mode === 'unset'
							? t('backups_enc_unset_short')
							: tDynamic(`app:backups_enc_state_${data.encryption.mode}`)}
						onclick={() => openPanel('encryption=1')}
						data-testid="encryption-row"
					>
						{#snippet lead()}<KeyRound size={18} aria-hidden="true" />{/snippet}
						{#snippet trail()}
							{#if data?.encryption.mode === 'unset'}<Pill>{t('backups_enc_pill_unset')}</Pill>{/if}
							<ChevronRight size={18} class="text-ink-soft" aria-hidden="true" />
						{/snippet}
					</Row>
					<Row wrap title={t('key_file_row_title')} meta={t('key_file_row_meta')}>
						{#snippet lead()}<FileKey size={18} aria-hidden="true" />{/snippet}
						{#snippet trail()}
							<Button
								variant="outline"
								size="sm"
								onclick={() => (savingKeyFile = true)}
								data-testid="key-file-save">{t('key_file_save')}</Button
							>
						{/snippet}
					</Row>
				</Card>
				<p class="text-ink-soft flex max-w-prose items-start gap-2 text-[13px]">
					<span>{t('backups_secret_short')}</span>
					<HelpTip text={t('backups_secret_reminder')} label={t('help')} />
				</p>
			</Section>

			<Section label={t('backups_targets_title')} count={data.targets.length || undefined}>
				{#snippet actions()}
					<Button variant="ghost" onclick={() => openPanel('new=1')}
						><Plus />{t('backups_add_copy')}</Button
					>
				{/snippet}
				{#if data.targets.length > 0}
					<Card rows>
						{#each data.targets as target (target.id)}
							{@const state = status(target)}
							<Row
								title={target.name}
								meta={state.text}
								onclick={() => openPanel(`edit=${target.id}`)}
								data-testid="backup-target"
							>
								{#snippet trail()}
									{#if state.bad}<Pill tone="attention">{t('backups_pill_problem')}</Pill>{/if}
									<ChevronRight size={18} class="text-ink-soft" aria-hidden="true" />
								{/snippet}
							</Row>
						{/each}
					</Card>
					{#if data.encryption.mode === 'unset'}
						<Notice tone="warn">{t('backups_need_encryption')}</Notice>
					{/if}
				{:else}
					<Notice>{t('backups_targets_empty')}</Notice>
				{/if}
			</Section>
			<Section label={t('backups_restore_title')}>
				<p class="text-ink-soft max-w-prose text-sm">{t('backups_restore_text')}</p>
				<Card rows>
					<Row title={t('backups_restore_guide')} href={RESTORE_GUIDE_URL} {...external} />
				</Card>
			</Section>
		{/if}
	</div>

	<EncryptionPanel
		open={encryptionOpen}
		current={data?.encryption.mode ?? 'unset'}
		onclose={closePanel}
		onchanged={load}
	/>
	<KeyFileDialog open={savingKeyFile} onclose={() => (savingKeyFile = false)} />
	<TargetPanel
		open={addingCopy || editing !== null}
		target={addingCopy ? null : editing}
		onclose={closePanel}
		onchanged={load}
	/>
</Page>
