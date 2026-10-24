<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { ConfirmButton, Notice, Segmented, SidePanel, SwitchRow } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { api } from '#lib/api.js';
	import { runAction } from '#lib/run-action.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { reason } from './reason.js';
	import type { Target, TargetKind } from './types.js';

	/**
	 * A copy elsewhere, in a panel (a sheet on phones): adds one, or edits one with its connection
	 * test and removal. Credentials left empty keep their saved value.
	 */
	let {
		open,
		target,
		onclose,
		onchanged,
	}: {
		open: boolean;
		/** The target to edit; null adds a new one. */
		target: Target | null;
		onclose: () => void;
		onchanged: () => void;
	} = $props();

	let kind = $state<TargetKind>('webdav');
	let name = $state('');
	let keep = $state('7');
	let endpoint = $state('');
	let region = $state('us-east-1');
	let bucket = $state('');
	let prefix = $state('');
	let accessKeyId = $state('');
	let secretAccessKey = $state('');
	let pathStyle = $state(false);
	let url = $state('');
	let username = $state('');
	let password = $state('');
	let enabled = $state(true);
	let busy = $state(false);
	let failed = $state(false);
	let test = $state<'running' | { ok: boolean; code: string } | null>(null);
	let form = $state<HTMLFormElement>();

	let shownFor: string | null | undefined;
	$effect(() => {
		if (!open) {
			shownFor = undefined;
			return;
		}
		const key = target?.id ?? null;
		if (shownFor === key) return;
		shownFor = key;
		const s = target?.summary;
		kind = target?.kind ?? 'webdav';
		name = target?.name ?? '';
		keep = String(target?.keep ?? 7);
		endpoint = s?.endpoint ?? '';
		region = s?.region ?? 'us-east-1';
		bucket = s?.bucket ?? '';
		prefix = s?.prefix ?? '';
		pathStyle = s?.pathStyle ?? false;
		url = s?.url ?? '';
		username = s?.username ?? '';
		accessKeyId = secretAccessKey = password = '';
		enabled = target?.enabled ?? true;
		failed = false;
		test = null;
	});

	/** Whether the connection settings differ from what is saved, or a secret was typed. */
	function configChanged(saved: Target, next: Record<string, string | boolean>): boolean {
		const s = saved.summary as Record<string, string | boolean | undefined>;
		return Object.entries(next).some(([key, value]) =>
			key in s || typeof value === 'boolean' ? s[key] !== value : value !== '',
		);
	}

	async function save() {
		busy = true;
		failed = false;
		await persist();
		busy = false;
	}

	async function persist() {
		const common = { name: name.trim(), keep: Number(keep) };
		const s3 = {
			endpoint: endpoint.trim(),
			region: region.trim(),
			bucket: bucket.trim(),
			prefix: prefix.trim(),
			accessKeyId: accessKeyId.trim(),
			secretAccessKey,
			pathStyle,
		};
		const dav = { url: url.trim(), username: username.trim(), password };
		if (target) {
			const result = await runAction(
				api.POST('/api/v1/actions/core.updateBackupTarget', {
					body: { targetId: target.id, ...common },
				}),
				{ onError: fail },
			);
			if (!result.ok) return;
			if (result.data.status !== 'applied') return fail();
			// The address and keys are one sealed credential, kept apart from the rest.
			if (configChanged(target, kind === 's3' ? s3 : dav)) {
				const config = await runAction(
					api.PUT('/api/v1/backups/targets/{targetId}/config', {
						params: { path: { targetId: target.id } },
						body: { config: kind === 's3' ? s3 : dav },
					}),
					{ onError: fail },
				);
				if (!config.ok) return;
			}
		} else {
			const created = await runAction(
				kind === 's3'
					? api.POST('/api/v1/backups/targets', { body: { kind: 's3', ...common, config: s3 } })
					: api.POST('/api/v1/backups/targets', {
							body: { kind: 'webdav', ...common, config: dav },
						}),
				{ onError: fail },
			);
			if (!created.ok) return;
		}
		onchanged();
		onclose();
	}

	const fail = () => {
		failed = true;
	};

	async function runTest() {
		if (!target) return;
		test = 'running';
		const result = await runAction(
			api.POST('/api/v1/backups/targets/{targetId}/test', {
				params: { path: { targetId: target.id } },
			}),
			{ onError: () => (test = { ok: false, code: 'unreachable' }) },
		);
		if (result.ok) test = result.data;
	}

	async function setEnabled(next: boolean) {
		if (!target) return;
		await runAction(
			api.POST('/api/v1/actions/core.updateBackupTarget', {
				body: { targetId: target.id, enabled: next },
			}),
			{ onError: fail },
		);
		onchanged();
	}

	async function remove() {
		if (!target) return;
		const result = await runAction(
			api.POST('/api/v1/actions/core.deleteBackupTarget', { body: { targetId: target.id } }),
			{ onError: fail },
		);
		if (!result.ok) return;
		onchanged();
		onclose();
	}

	const keepSecret = $derived(target ? t('backups_f_keep_secret') : undefined);
	const idp = $derived(target?.id ?? 'new');
</script>

{#snippet removeButton()}
	<ConfirmButton
		label={t('backups_target_remove')}
		confirmLabel={t('backups_target_remove_yes')}
		onconfirm={remove}
	/>
{/snippet}

<SidePanel
	{open}
	title={target ? target.name : t('backups_add_copy')}
	{onclose}
	closeLabel={t('side_panel_close')}
	cancelLabel={t('cancel')}
	saveLabel={target ? t('backups_target_save') : t('backups_target_add')}
	saveDisabled={busy}
	onsave={() => form?.requestSubmit()}
	danger={target ? removeButton : undefined}
>
	<div class="grid gap-5">
		{#if !target}
			<Segmented
				label={t('backups_targets_title')}
				grow
				bind:value={kind}
				options={[
					{ value: 'webdav', label: tDynamic('app:backups_kind_webdav') },
					{ value: 's3', label: tDynamic('app:backups_kind_s3') },
				]}
			/>
		{/if}
		<p class="text-ink-soft text-sm">
			{kind === 's3' ? t('backups_s3_hint') : t('backups_webdav_hint')}
		</p>
		{#if failed}<Notice tone="alert">{t('backups_target_failed')}</Notice>{/if}

		<form
			bind:this={form}
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
			class="grid gap-4"
		>
			<div class="grid gap-1.5">
				<Label for="{idp}-name">{t('backups_f_name')}</Label>
				<Input id="{idp}-name" bind:value={name} required maxlength={60} />
			</div>

			{#if kind === 's3'}
				<div class="grid gap-1.5">
					<Label for="{idp}-endpoint">{t('backups_f_endpoint')}</Label>
					<Input id="{idp}-endpoint" type="url" bind:value={endpoint} required spellcheck={false} />
					<p class="text-ink-soft text-[13px]">{t('backups_f_endpoint_hint')}</p>
				</div>
				<div class="grid grid-cols-2 gap-4">
					<div class="grid gap-1.5">
						<Label for="{idp}-region">{t('backups_f_region')}</Label>
						<Input id="{idp}-region" bind:value={region} required spellcheck={false} />
					</div>
					<div class="grid gap-1.5">
						<Label for="{idp}-bucket">{t('backups_f_bucket')}</Label>
						<Input id="{idp}-bucket" bind:value={bucket} required spellcheck={false} />
					</div>
				</div>
				<div class="grid gap-1.5">
					<Label for="{idp}-prefix">{t('backups_f_prefix')}</Label>
					<Input id="{idp}-prefix" bind:value={prefix} spellcheck={false} />
				</div>
				<div class="grid gap-1.5">
					<Label for="{idp}-akid">{t('backups_f_access_key')}</Label>
					<Input
						id="{idp}-akid"
						bind:value={accessKeyId}
						required={!target}
						autocomplete="off"
						spellcheck={false}
					/>
				</div>
				<div class="grid gap-1.5">
					<Label for="{idp}-secret">{t('backups_f_secret_key')}</Label>
					<Input
						id="{idp}-secret"
						type="password"
						bind:value={secretAccessKey}
						required={!target}
						autocomplete="off"
					/>
					{#if keepSecret}<p class="text-ink-soft text-[13px]">{keepSecret}</p>{/if}
				</div>
				<div class="border-line -mx-5 border-y">
					<SwitchRow
						id="{idp}-path"
						label={t('backups_f_path_style')}
						hint={t('backups_f_path_style_hint')}
						bind:checked={pathStyle}
					/>
				</div>
			{:else}
				<div class="grid gap-1.5">
					<Label for="{idp}-url">{t('backups_f_url')}</Label>
					<Input id="{idp}-url" type="url" bind:value={url} required spellcheck={false} />
				</div>
				<div class="grid gap-1.5">
					<Label for="{idp}-user">{t('backups_f_username')}</Label>
					<Input
						id="{idp}-user"
						bind:value={username}
						required
						autocomplete="off"
						spellcheck={false}
					/>
				</div>
				<div class="grid gap-1.5">
					<Label for="{idp}-password">{t('backups_f_password')}</Label>
					<Input
						id="{idp}-password"
						type="password"
						bind:value={password}
						required={!target}
						autocomplete="off"
					/>
					{#if keepSecret}<p class="text-ink-soft text-[13px]">{keepSecret}</p>{/if}
				</div>
			{/if}

			<div class="grid gap-1.5">
				<Label for="{idp}-keep">{t('backups_f_keep')}</Label>
				<Input
					id="{idp}-keep"
					type="number"
					bind:value={keep}
					min={1}
					max={365}
					required
					class="w-28"
				/>
				<p class="text-ink-soft text-[13px]">{t('backups_f_keep_hint')}</p>
			</div>
		</form>

		{#if target}
			<div class="border-line -mx-5 border-y">
				<SwitchRow
					id="enabled-{target.id}"
					label={t('backups_target_enabled')}
					bind:checked={enabled}
					onchange={setEnabled}
				/>
			</div>
			<div class="grid gap-3">
				<div>
					<Button variant="outline" onclick={runTest} disabled={test === 'running'}>
						{t('backups_target_test')}
					</Button>
				</div>
				{#if test === 'running'}
					<Notice>{t('backups_target_testing')}</Notice>
				{:else if test}
					<div role="status">
						<Notice tone={test.ok ? 'info' : 'warn'}>
							{test.ok
								? t('backups_target_test_ok')
								: t('backups_target_test_failed', { reason: reason(test.code) })}
						</Notice>
					</div>
				{/if}
				<p class="text-ink-soft text-[13px]">{t('backups_target_remove_hint')}</p>
			</div>
		{/if}
	</div>
</SidePanel>
