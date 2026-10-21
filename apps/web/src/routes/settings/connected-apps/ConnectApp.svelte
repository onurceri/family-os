<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		FIELD_REASON,
		fieldAria,
		FieldError,
		focusFirstInvalid,
		Notice,
		Segmented,
		SidePanel,
		Step,
		Steps,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Check, Copy } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import SelectField from '#lib/SelectField.svelte';
	import { APP_KINDS, type AppKind, appSettings, mcpAddress } from './app-settings.js';

	/**
	 * "Connect an AI app" (guided steps): turn AI apps on (once, for the whole family; an
	 * admin), create a key for the app, copy the settings into the app. The key is shown only in
	 * the last step, once.
	 */
	let {
		open,
		enabled,
		isAdmin,
		onenable,
		onclose,
		onchanged,
	}: {
		open: boolean;
		/** Whether AI apps may connect for the family. */
		enabled: boolean;
		isAdmin: boolean;
		/** Turns AI apps on; true when it worked. */
		onenable: () => Promise<boolean>;
		onclose: () => void;
		/** A key was created: the page reloads its list. */
		onchanged: () => void;
	} = $props();

	let step = $state(1);
	let name = $state('');
	let scope = $state<'read' | 'read_write'>('read');
	let days = $state(90);
	let made = $state<{ name: string; secret: string } | null>(null);
	let kind = $state<AppKind>('claude-desktop');
	let copied = $state<'key' | 'settings' | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	// The name's reason shows from the first refused Create on, and goes once it is typed.
	let tried = $state(false);
	const nameError = $derived(tried && !name.trim() ? FIELD_REASON.name : undefined);

	const address = mcpAddress(typeof location === 'undefined' ? '' : location.origin);
	const settings = $derived(appSettings(kind, address, made?.secret ?? null));

	// Each opening starts fresh; the first step is done when AI apps are already on.
	$effect(() => {
		if (!open) return;
		step = enabled ? 2 : 1;
		name = '';
		scope = 'read';
		days = 90;
		made = null;
		kind = 'claude-desktop';
		copied = null;
		error = null;
		tried = false;
	});

	async function turnOn() {
		error = null;
		busy = true;
		try {
			if (await onenable()) step = 2;
			else error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		if (!name.trim()) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		error = null;
		busy = true;
		try {
			const result = unwrap(
				await api.POST('/api/v1/mcp/tokens', { body: { name, scope, expiresInDays: days } }),
			);
			made = { name, secret: result.secret };
			step = 3;
			onchanged();
		} catch {
			error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	async function copy(text: string, what: 'key' | 'settings') {
		try {
			await navigator.clipboard.writeText(text);
			copied = what;
		} catch {
			// The text is selectable; copying by hand still works.
		}
	}
</script>

{#snippet copyButton(text: string, what: 'key' | 'settings')}
	<Button size="sm" variant="secondary" onclick={() => copy(text, what)}>
		{#if copied === what}<Check class="size-4" aria-hidden="true" />{:else}<Copy
				class="size-4"
				aria-hidden="true"
			/>{/if}
		{copied === what ? t('mcp_copied') : t('mcp_copy')}
	</Button>
{/snippet}

<SidePanel
	{open}
	title={t('mcp_add')}
	closeLabel={t('side_panel_close')}
	cancelLabel={step === 3 ? t('devices_close') : t('cancel')}
	{onclose}
	dirty={step === 2 && name !== ''}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	<div class="grid gap-5" data-testid="connect-app">
		<Steps current={step} label={t('mcp_add')} doneLabel={t('steps_done')}>
			<Step n={1} title={t('mcp_step_on')} summary={t('mcp_step_on_summary')}>
				<p class="text-ink-soft text-sm">{t('mcp_step_on_body')}</p>
				{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
				<div>
					{#if isAdmin}
						<Button variant="primary" disabled={busy} onclick={turnOn}>{t('mcp_turn_on')}</Button>
					{:else}
						<Notice tone="warn">{t('mcp_off')}</Notice>
					{/if}
				</div>
			</Step>

			<Step n={2} title={t('mcp_step_key')} summary={made?.name}>
				<p class="text-ink-soft text-sm">{t('mcp_step_key_body')}</p>
				<form class="grid gap-4" onsubmit={create} novalidate>
					<div class="grid gap-1.5">
						<Label for="mcp-name">{t('mcp_name')}</Label>
						<Input
							id="mcp-name"
							bind:value={name}
							required
							maxlength={60}
							placeholder={t('mcp_name_placeholder')}
							aria-describedby={nameError ? 'mcp-name-error mcp-name-hint' : 'mcp-name-hint'}
							aria-invalid={nameError ? 'true' : undefined}
						/>
						<FieldError for="mcp-name" error={nameError} />
						<small id="mcp-name-hint" class="text-ink-soft text-[13px] leading-snug"
							>{t('mcp_name_hint')}</small
						>
					</div>
					<div class="grid gap-1.5">
						<Label for="mcp-scope">{t('mcp_scope')}</Label>
						<SelectField id="mcp-scope" bind:value={scope}>
							<option value="read">{t('mcp_scope_read')}</option>
							<option value="read_write">{t('mcp_scope_read_write')}</option>
						</SelectField>
						<small class="text-ink-soft text-[13px] leading-snug">{t('mcp_scope_hint')}</small>
					</div>
					<div class="grid gap-1.5">
						<Label for="mcp-days">{t('mcp_expiry')}</Label>
						<SelectField id="mcp-days" bind:value={days}>
							{#each [30, 90, 180, 365] as option (option)}
								<option value={option}>{t('mcp_expiry_days', { count: option })}</option>
							{/each}
						</SelectField>
					</div>
					{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
					<div>
						<Button type="submit" variant="primary" disabled={busy}>{t('mcp_create')}</Button>
					</div>
				</form>
			</Step>

			<Step n={3} title={t('mcp_step_copy')}>
				{#if made}
					<div class="grid gap-2" data-testid="mcp-secret-box">
						<p class="text-sm font-semibold">{t('mcp_secret_once')}</p>
						<code
							class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-sm break-all"
							data-testid="mcp-secret">{made.secret}</code
						>
						<div>{@render copyButton(made.secret, 'key')}</div>
					</div>
				{/if}
				<div class="grid gap-2">
					<Segmented
						label={t('mcp_which_app')}
						size="sm"
						grow
						value={kind}
						onchange={(v) => {
							kind = v as AppKind;
							copied = copied === 'settings' ? null : copied;
						}}
						options={APP_KINDS.map((k) => ({
							value: k,
							label: tDynamic(`app:mcp_kind_${k.replace('-', '_')}`),
						}))}
					/>
					<p class="text-ink-soft text-sm">
						{tDynamic(`app:mcp_kind_${kind.replace('-', '_')}_how`)}
					</p>
					<pre
						class="bg-idle rounded-[var(--r-ctl)] px-3 py-2 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap"
						data-testid="mcp-settings">{settings}</pre>
					<div>{@render copyButton(settings, 'settings')}</div>
				</div>
				<p class="text-ink-soft text-[13px]">
					{t('mcp_endpoint')}:
					<code class="break-all" data-testid="mcp-endpoint">{address}</code>
				</p>
				<div><Button variant="primary" onclick={onclose}>{t('mcp_done')}</Button></div>
			</Step>
		</Steps>
	</div>
</SidePanel>
