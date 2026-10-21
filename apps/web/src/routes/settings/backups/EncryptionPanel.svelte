<script lang="ts">
	import { isApiError, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Dialog, Notice, Segmented, SidePanel, Step, Steps } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { api } from '#lib/api.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { LOCK_MODES, type LockMode, lockMismatch, lockReady, MIN_PASSPHRASE } from './lock.js';

	/**
	 * How copies are locked (encrypted) before they leave this server, in three guided steps: why,
	 * choose a passphrase (with the "I have written it down" check), done with what to keep where.
	 * A public key or no lock at all are folded under "Other ways" in the first step.
	 */
	let {
		open,
		current,
		onclose,
		onchanged,
	}: {
		open: boolean;
		/** The lock chosen now, said in the first step when there is one. */
		current: LockMode | 'unset';
		onclose: () => void;
		onchanged: () => void;
	} = $props();

	let step = $state(1);
	let mode = $state<LockMode>('passphrase');
	let otherWays = $state(false);
	let passphrase = $state('');
	let again = $state('');
	let written = $state(false);
	let recipient = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	let confirmingNone = $state(false);

	$effect(() => {
		if (!open) return;
		step = 1;
		mode = 'passphrase';
		otherWays = false;
		passphrase = again = recipient = '';
		written = false;
		error = null;
	});

	const fields = $derived({ passphrase, again, written, recipient });
	const mismatch = $derived(lockMismatch(fields));
	const ready = $derived(lockReady(mode, fields));
	const modeName = (m: LockMode) => tDynamic(`app:backups_enc_mode_${m}`);

	async function save() {
		error = null;
		confirmingNone = false;
		busy = true;
		try {
			// A passphrase is a secret, so it has a route of its own; the other choices are actions.
			if (mode === 'passphrase')
				unwrap(await api.PUT('/api/v1/backups/encryption/passphrase', { body: { passphrase } }));
			else
				unwrap(
					await api.POST('/api/v1/actions/core.setBackupEncryption', {
						body:
							mode === 'recipient'
								? { mode: 'recipient' as const, recipient: recipient.trim() }
								: { mode: 'none' as const },
					}),
				);
			// The passphrase leaves memory as soon as the server has it.
			passphrase = again = '';
			step = 3;
			onchanged();
		} catch (e) {
			error =
				isApiError(e) && e.code === 'bad_request' ? t('backups_enc_invalid') : t('error_generic');
		} finally {
			busy = false;
		}
	}
	function submit() {
		if (!ready || busy) return;
		if (mode === 'none') confirmingNone = true;
		else void save();
	}

	const chooseTitle = $derived(
		mode === 'passphrase'
			? t('backups_enc_step_passphrase')
			: mode === 'recipient'
				? t('backups_enc_step_recipient')
				: t('backups_enc_step_none'),
	);
	const doneText = $derived(
		mode === 'passphrase'
			? t('backups_enc_done_passphrase')
			: mode === 'recipient'
				? t('backups_enc_done_recipient')
				: t('backups_enc_done_none'),
	);
</script>

<SidePanel
	{open}
	title={t('backups_enc_title')}
	{onclose}
	closeLabel={t('side_panel_close')}
	cancelLabel={step === 3 ? t('devices_close') : t('cancel')}
	dirty={step === 2 && (passphrase !== '' || recipient !== '')}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	<div class="grid gap-5" data-testid="encryption-steps">
		<Steps
			current={step}
			onselect={step < 3 ? (n) => (step = n) : undefined}
			label={t('backups_enc_title')}
			doneLabel={t('steps_done')}
		>
			<Step n={1} title={t('backups_enc_step_why')} summary={modeName(mode)}>
				<p class="text-sm">{t('backups_enc_why')}</p>
				<p class="text-ink-soft text-sm">{t('backups_enc_why_here')}</p>
				{#if current !== 'unset'}
					<Notice>{tDynamic(`app:backups_enc_now_${current}`)}</Notice>
				{/if}
				{#if otherWays}
					<Segmented
						label={t('backups_enc_how')}
						grow
						bind:value={mode}
						options={LOCK_MODES.map((m) => ({ value: m, label: modeName(m) }))}
					/>
				{/if}
				<div class="flex flex-wrap gap-2">
					<Button variant="primary" onclick={() => (step = 2)}>{t('devices_next')}</Button>
					{#if !otherWays}
						<Button variant="ghost" onclick={() => (otherWays = true)}
							>{t('backups_enc_other_ways')}</Button
						>
					{/if}
				</div>
			</Step>

			<Step n={2} title={chooseTitle}>
				<form
					class="grid gap-4"
					onsubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					{#if error}<Notice tone="alert">{error}</Notice>{/if}
					{#if mode === 'passphrase'}
						<p class="text-ink-soft text-sm">{t('backups_enc_passphrase_what')}</p>
						<div class="grid gap-1.5">
							<Label for="backup-passphrase">{t('backups_enc_passphrase')}</Label>
							<Input
								id="backup-passphrase"
								type="password"
								bind:value={passphrase}
								autocomplete="new-password"
								minlength={MIN_PASSPHRASE}
								maxlength={500}
							/>
							<p class="text-ink-soft text-[13px]">{t('backups_enc_passphrase_hint')}</p>
						</div>
						<div class="grid gap-1.5">
							<Label for="backup-passphrase-again">{t('backups_enc_passphrase_again')}</Label>
							<Input
								id="backup-passphrase-again"
								type="password"
								bind:value={again}
								autocomplete="new-password"
							/>
							{#if mismatch}
								<p class="text-attention text-[13px] font-semibold" role="alert">
									{t('backups_enc_mismatch')}
								</p>
							{/if}
						</div>
						<Notice tone="warn">{t('backups_enc_warning')}</Notice>
						<label class="flex min-h-11 items-center gap-3 text-sm font-semibold">
							<input type="checkbox" class="accent-ink size-5" bind:checked={written} />
							{t('backups_enc_written')}
						</label>
					{:else if mode === 'recipient'}
						<div class="grid gap-1.5">
							<Label for="backup-recipient">{t('backups_enc_recipient')}</Label>
							<Input
								id="backup-recipient"
								bind:value={recipient}
								spellcheck={false}
								autocomplete="off"
								placeholder="age1…"
							/>
							<p class="text-ink-soft text-[13px]">{t('backups_enc_recipient_hint')}</p>
						</div>
					{:else}
						<Notice tone="warn">{t('backups_enc_none_warning')}</Notice>
					{/if}
					<div>
						{#if mode === 'none'}
							<Button type="submit" variant="danger" disabled={busy}
								>{t('backups_enc_none_yes')}</Button
							>
						{:else}
							<Button type="submit" variant="primary" disabled={!ready || busy}
								>{mode === 'passphrase'
									? t('backups_enc_save_passphrase')
									: t('backups_enc_save_recipient')}</Button
							>
						{/if}
					</div>
				</form>
			</Step>

			<Step n={3} title={t('backups_enc_step_done')}>
				<p role="status">{doneText}</p>
				{#if mode !== 'none'}
					<div class="grid gap-2">
						<p class="text-sm font-semibold">{t('backups_enc_keep_title')}</p>
						<ul class="text-ink-soft grid list-disc gap-1 ps-5 text-sm">
							<li>{t('backups_enc_keep_copy')}</li>
							<li>
								{mode === 'passphrase'
									? t('backups_enc_keep_passphrase')
									: t('backups_enc_keep_private_key')}
							</li>
							<li>{t('backups_enc_keep_key_file')}</li>
						</ul>
					</div>
				{/if}
				<div><Button variant="primary" onclick={onclose}>{t('devices_close')}</Button></div>
			</Step>
		</Steps>
	</div>
</SidePanel>

<Dialog
	open={confirmingNone}
	title={t('backups_enc_none_yes')}
	description={t('backups_enc_none_warning')}
	onclose={() => (confirmingNone = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (confirmingNone = false)}
			>{t('cancel')}</Button
		>
		<Button variant="danger" onclick={save}>{t('backups_enc_none_yes')}</Button>
	{/snippet}
</Dialog>
