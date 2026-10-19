<script lang="ts">
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { type paths, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		ConfirmButton,
		FIELD_REASON,
		FieldError,
		focusFirstInvalid,
		MemberChips,
		Notice,
		Segmented,
		SidePanel,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Check, Copy } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import { api } from '#lib/api.js';
	import { family } from '#lib/family.svelte.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import SelectField from '#lib/SelectField.svelte';
	import { expiryState } from './apps.js';

	type Apps = paths['/api/v1/apps']['get']['responses'][200]['content']['application/json'];
	export type ConnectedApp = Apps['apps'][number];
	type Roles = paths['/api/v1/core/roles']['get']['responses'][200]['content']['application/json'];

	/**
	 * One connected app: adding it (name, role, mode, who it may act for), then its key shown once;
	 * or changing it, rotating its keys, pausing it and revoking it. Only an admin gets here.
	 */
	let {
		open,
		app,
		roles,
		warnDays,
		onclose,
		onchanged,
	}: {
		open: boolean;
		/** The app being changed, or null to add one. */
		app: ConnectedApp | null;
		roles: Roles['roles'];
		warnDays: number;
		onclose: () => void;
		/** Something changed: the page reloads its list. */
		onchanged: () => void;
	} = $props();

	let name = $state('');
	let roleId = $state('member');
	let mode = $state<'apply' | 'suggest'>('apply');
	let actsFor = $state<string[]>([]);
	let days = $state(0);
	/** A key just made: shown once, whether for a new app or an added key. */
	let made = $state<{ label: string; secret: string } | null>(null);
	let keyName = $state('');
	let copied = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let tried = $state(false);
	let form = $state<HTMLFormElement>();
	const nameError = $derived(tried && !name.trim() ? FIELD_REASON.name : undefined);

	const when = (ms: number) => dateTimeFormat({ dateStyle: 'medium' }).format(ms);
	const roleName = (id: string) => {
		const role = roles.find((r) => r.id === id);
		return role?.name ?? tDynamic(`app:role_${id}`);
	};
	const roleHint = (id: string) => {
		const role = roles.find((r) => r.id === id);
		if (!role) return '';
		return role.builtIn
			? tDynamic(`app:role_${id}_hint`)
			: t('role_custom_hint', { base: tDynamic(`app:role_${role.base}`) });
	};
	const address = typeof location === 'undefined' ? '' : location.origin;
	const live = $derived(app !== null && app.revokedAt === null);
	const paused = $derived(app?.pausedAt != null);
	const dirty = $derived(
		made === null &&
			(app === null
				? name !== ''
				: name !== app.name ||
					roleId !== app.roleId ||
					mode !== app.mode ||
					JSON.stringify([...actsFor].sort()) !== JSON.stringify([...app.actsFor].sort())),
	);

	// Each opening starts from the app (or fresh). Only opening, or another app, resets the form:
	// a reload of the same app (after a key was added) must not hide the key just shown.
	$effect(() => {
		if (!open) return;
		void app?.id;
		untrack(() => {
			name = app?.name ?? '';
			roleId = app?.roleId ?? 'member';
			mode = app?.mode ?? 'apply';
			actsFor = app ? [...app.actsFor] : [];
			days = 0;
			made = null;
			keyName = t('apps_key_name_default');
			copied = false;
			error = null;
			tried = false;
		});
	});

	async function save() {
		tried = true;
		if (!name.trim()) {
			if (form) void focusFirstInvalid(form);
			return;
		}
		error = null;
		busy = true;
		try {
			if (app === null) {
				const result = unwrap(
					await api.POST('/api/v1/apps', {
						body: {
							name,
							roleId,
							mode,
							actsFor,
							...(days > 0 && { expiresInDays: days }),
						},
					}),
				);
				made = { label: result.app.name, secret: result.secret };
			} else {
				unwrap(
					await api.PATCH('/api/v1/apps/{appId}', {
						params: { path: { appId: app.id } },
						body: { name, roleId, mode, actsFor },
					}),
				);
				onclose();
			}
			onchanged();
		} catch {
			error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function addKey() {
		if (!app) return;
		error = null;
		busy = true;
		try {
			const result = unwrap(
				await api.POST('/api/v1/apps/{appId}/tokens', {
					params: { path: { appId: app.id } },
					body: {
						name: keyName.trim() || t('apps_key_name_default'),
						...(days > 0 && { expiresInDays: days }),
					},
				}),
			);
			made = { label: app.name, secret: result.secret };
			onchanged();
		} catch {
			error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function revokeKey(tokenId: string) {
		if (!app) return;
		error = null;
		try {
			unwrap(
				await api.DELETE('/api/v1/apps/{appId}/tokens/{tokenId}', {
					params: { path: { appId: app.id, tokenId } },
				}),
			);
			onchanged();
		} catch {
			error = t('error_generic');
		}
	}

	async function setPaused(on: boolean) {
		if (!app) return;
		error = null;
		try {
			unwrap(
				await api.POST(on ? '/api/v1/apps/{appId}/pause' : '/api/v1/apps/{appId}/resume', {
					params: { path: { appId: app.id } },
				}),
			);
			onchanged();
		} catch {
			error = t('error_generic');
		}
	}

	async function revokeApp() {
		if (!app) return;
		error = null;
		try {
			unwrap(await api.DELETE('/api/v1/apps/{appId}', { params: { path: { appId: app.id } } }));
			onchanged();
			onclose();
		} catch {
			error = t('error_generic');
		}
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			// The text is selectable; copying by hand still works.
		}
	}

	const keyStatus = (token: ConnectedApp['tokens'][number]) => {
		const state = expiryState(token, Date.now(), warnDays);
		if (state.kind === 'revoked') return t('apps_key_revoked');
		if (state.kind === 'expired') return t('apps_key_expired');
		if (state.kind === 'soon') return t('apps_key_expiring', { date: when(state.at) });
		if (state.kind === 'later') return t('apps_key_expires', { date: when(state.at) });
		return t('apps_key_never_expires');
	};
</script>

{#snippet revokeAppButton()}
	{#if app && live}
		<ConfirmButton
			label={t('apps_revoke')}
			confirmLabel={t('apps_revoke_confirm')}
			onconfirm={revokeApp}
		/>
	{/if}
{/snippet}

<SidePanel
	{open}
	title={app ? t('apps_edit_title', { name: app.name }) : t('apps_add')}
	closeLabel={t('side_panel_close')}
	cancelLabel={made ? t('devices_close') : t('cancel')}
	saveLabel={app ? t('apps_save') : t('apps_create')}
	onsave={made || (app && !live) ? undefined : () => form?.requestSubmit()}
	saveDisabled={busy}
	danger={app && live && !made ? revokeAppButton : undefined}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
	{onclose}
>
	<div class="grid gap-5" data-testid="app-panel">
		{#if made}
			<div class="grid gap-3" data-testid="app-secret-box">
				<h3 class="text-base font-bold">{t('apps_key_title')}</h3>
				<p class="text-sm font-semibold">{t('apps_key_once')}</p>
				<code
					class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
					data-testid="app-secret">{made.secret}</code
				>
				<div>
					<Button size="sm" variant="secondary" onclick={() => copy(made?.secret ?? '')}>
						{#if copied}<Check class="size-4" aria-hidden="true" />{:else}<Copy
								class="size-4"
								aria-hidden="true"
							/>{/if}
						{copied ? t('mcp_copied') : t('mcp_copy')}
					</Button>
				</div>
				<p class="text-ink-soft text-sm">{t('apps_ha_hint', { address })}</p>
				{#if actsFor.length > 0}
					<p class="text-ink-soft text-sm">{t('apps_on_behalf_hint')}</p>
				{/if}
				<div><Button variant="primary" onclick={onclose}>{t('mcp_done')}</Button></div>
			</div>
		{:else}
			{#if app && paused && live}
				<Notice tone="warn">{t('apps_paused_hint')}</Notice>
			{/if}
			<form
				class="grid gap-4"
				bind:this={form}
				onsubmit={(event) => {
					event.preventDefault();
					void save();
				}}
				novalidate
			>
				<div class="grid gap-1.5">
					<Label for="app-name">{t('apps_name')}</Label>
					<Input
						id="app-name"
						bind:value={name}
						required
						maxlength={60}
						placeholder={t('apps_name_placeholder')}
						disabled={app !== null && !live}
						aria-describedby={nameError ? 'app-name-error' : undefined}
						aria-invalid={nameError ? 'true' : undefined}
					/>
					<FieldError for="app-name" error={nameError} />
				</div>
				<div class="grid gap-1.5">
					<Label for="app-role">{t('apps_role')}</Label>
					<SelectField id="app-role" bind:value={roleId} disabled={app !== null && !live}>
						{#each roles as role (role.id)}
							<option value={role.id}>{roleName(role.id)}</option>
						{/each}
					</SelectField>
					<small class="text-ink-soft text-[13px] leading-snug">{roleHint(roleId)}</small>
					<small class="text-ink-soft text-[13px] leading-snug">{t('apps_never_hint')}</small>
				</div>
				<div class="grid gap-1.5">
					<Segmented
						label={t('apps_mode')}
						size="sm"
						grow
						value={mode}
						onchange={(v) => (mode = v as 'apply' | 'suggest')}
						options={[
							{ value: 'apply', label: t('apps_mode_apply') },
							{ value: 'suggest', label: t('apps_mode_suggest') },
						]}
					/>
					<small class="text-ink-soft text-[13px] leading-snug">
						{mode === 'apply' ? t('apps_mode_apply_hint') : t('apps_mode_suggest_hint')}
					</small>
				</div>
				<div class="grid gap-1.5">
					<span class="text-sm font-semibold">{t('apps_acts_for_label')}</span>
					<MemberChips members={family.members} bind:selected={actsFor} multiple />
					<small class="text-ink-soft text-[13px] leading-snug">{t('apps_acts_for_hint')}</small>
				</div>
				{#if app === null}
					<div class="grid gap-1.5">
						<Label for="app-days">{t('apps_key_expiry')}</Label>
						<SelectField id="app-days" bind:value={days}>
							<option value={0}>{t('apps_expiry_never')}</option>
							{#each [30, 90, 180, 365] as option (option)}
								<option value={option}>{t('mcp_expiry_days', { count: option })}</option>
							{/each}
						</SelectField>
					</div>
				{/if}
				{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
			</form>

			{#if app}
				<div class="grid gap-2" data-testid="app-keys">
					<h3 class="text-ink-soft text-xs font-bold tracking-wide uppercase">{t('apps_keys')}</h3>
					<ul class="grid gap-2">
						{#each app.tokens as token (token.id)}
							<li
								class="bg-idle flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-ctl)] px-3 py-2"
							>
								<span class="grid min-w-0 text-sm">
									<span class="font-semibold break-words">{token.name}</span>
									<span class="text-ink-soft text-[13px]"
										>{keyStatus(token)} · {token.lastUsedAt
											? t('apps_key_last_used', { date: when(token.lastUsedAt) })
											: t('apps_key_unused')}</span
									>
								</span>
								{#if token.revokedAt === null}
									<ConfirmButton
										label={t('apps_key_revoke')}
										confirmLabel={t('apps_key_revoke_confirm')}
										onconfirm={() => revokeKey(token.id)}
									/>
								{/if}
							</li>
						{/each}
					</ul>
					{#if live}
						<div class="grid gap-1.5">
							<Label for="app-key-name">{t('apps_key_name')}</Label>
							<Input id="app-key-name" bind:value={keyName} maxlength={60} />
						</div>
						<div class="grid gap-1.5">
							<Label for="app-key-days">{t('apps_key_expiry')}</Label>
							<SelectField id="app-key-days" bind:value={days}>
								<option value={0}>{t('apps_expiry_never')}</option>
								{#each [30, 90, 180, 365] as option (option)}
									<option value={option}>{t('mcp_expiry_days', { count: option })}</option>
								{/each}
							</SelectField>
						</div>
						<div class="flex flex-wrap gap-2">
							<Button variant="secondary" size="sm" disabled={busy} onclick={addKey}
								>{t('apps_key_add')}</Button
							>
							<Button variant="ghost" size="sm" onclick={() => setPaused(!paused)}
								>{paused ? t('apps_resume') : t('apps_pause')}</Button
							>
						</div>
						<small class="text-ink-soft text-[13px] leading-snug"
							>{t('apps_key_replace_hint')}</small
						>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</SidePanel>
