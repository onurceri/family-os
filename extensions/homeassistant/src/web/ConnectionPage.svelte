<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Card,
		Dialog,
		FieldError,
		fieldAria,
		focusFirstInvalid,
		IconButton,
		Menu,
		type MenuItem,
		Notice,
		Page,
		PageHeader,
		Row,
		Section,
		SidePanel,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { Ellipsis, Plus, RefreshCw } from '@lucide/svelte';
	import { onDestroy, onMount } from 'svelte';
	import {
		type Connection,
		type ConnectionStatus,
		normalizeBaseUrl,
		TokenSchema,
	} from '../contract/index.js';
	import { checkAgain, connect, disconnect, loadConnection } from './data.js';
	import { useHomeAssistant } from './i18n.js';

	/**
	 * Settings, Family, Home Assistant: the address and the token of the family's Home Assistant,
	 * and what the last check found. Managers only. The token is typed into the panel once; it is
	 * never shown again, so changing the connection asks for it again.
	 */
	const { app, t } = useHomeAssistant();

	let connection = $state<Connection>({ connected: false });
	let panelOpen = $state(false);
	let disconnecting = $state(false);
	let address = $state('');
	let token = $state('');
	let busy = $state(false);
	let failed = $state(false);
	let showErrors = $state(false);
	let formEl = $state<HTMLFormElement>();

	async function load() {
		try {
			connection = await loadConnection();
		} catch {
			connection = { connected: false };
		}
	}
	onMount(() => void load());
	// The check finishes in the background; the page follows.
	let off: (() => void) | undefined;
	onMount(() => {
		off = app.onEvent('homeassistant.connection', () => void load());
	});
	onDestroy(() => off?.());

	const connected = $derived(connection.connected ? connection : null);

	/** The address as typed before, to change one part of it; the token is never filled in. */
	function addressText(c: NonNullable<typeof connected>): string {
		const { scheme, host, port, path } = c.address;
		const shown = host.includes(':') ? `[${host}]` : host;
		return `${scheme}://${shown}${port === null ? '' : `:${port}`}${path ?? ''}`;
	}

	function startConnect() {
		address = connected ? addressText(connected) : '';
		token = '';
		showErrors = false;
		failed = false;
		panelOpen = true;
	}

	const errors = $derived({
		...(normalizeBaseUrl(address) ? {} : { address: 'homeassistant:address_error' }),
		...(TokenSchema.safeParse(token).success ? {} : { token: 'homeassistant:token_error' }),
	} as Record<string, string>);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (Object.keys(errors).length) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		failed = false;
		try {
			await connect({ url: address.trim(), token: token.trim() });
			app.toast(t('connect_started'));
			token = '';
			panelOpen = false;
			await load();
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	async function recheck() {
		try {
			await checkAgain();
			app.toast(t('check_started'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	async function forget() {
		disconnecting = false;
		try {
			await disconnect();
			app.toast(t('disconnected'));
			await load();
		} catch {
			app.toast(t('error'));
		}
	}

	const menu = $derived<MenuItem[]>([
		{ id: 'change', label: t('change'), onselect: startConnect },
		{
			id: 'disconnect',
			label: t('disconnect'),
			danger: true,
			onselect: () => (disconnecting = true),
		},
	]);

	const when = (ms: number) =>
		new Intl.DateTimeFormat(app.dateLocale(), {
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: app.hourCycle(),
			timeZone: app.timeZone(),
		}).format(ms);

	const STATUS_TEXT = {
		checking: 'status_checking',
		ok: 'status_ok',
		token_refused: 'status_token_refused',
		not_home_assistant: 'status_not_home_assistant',
		unreachable: 'status_unreachable',
		blocked_address: 'status_blocked_address',
		timeout: 'status_timeout',
		failed: 'status_failed',
	} as const satisfies Record<ConnectionStatus, string>;

	const ADVICE_TEXT = {
		checking: 'advice_checking',
		ok: 'advice_ok',
		token_refused: 'advice_token_refused',
		not_home_assistant: 'advice_not_home_assistant',
		unreachable: 'advice_unreachable',
		blocked_address: 'advice_blocked_address',
		timeout: 'advice_timeout',
		failed: 'advice_failed',
	} as const satisfies Record<ConnectionStatus, string>;

	/** What to do about the status; a name ending in .local gets the reason it cannot work. */
	function advice(c: NonNullable<typeof connected>): string {
		if (c.status === 'unreachable' && c.address.host.endsWith('.local'))
			return t('advice_unreachable_local');
		return t(ADVICE_TEXT[c.status]);
	}
</script>

<Page template="settings">
	<PageHeader title={t('nav_label')} subtitle={t('subtitle')}>
		{#snippet actions()}
			{#if connected}
				<Button variant="outline" onclick={recheck}
					><RefreshCw class="size-4" aria-hidden="true" />{t('check_again')}</Button
				>
				<Menu label={t('options')} title={t('nav_label')} cancelLabel={t('cancel')} items={menu}>
					{#snippet trigger({ attrs })}
						<IconButton label={t('options')} variant="outline" {...attrs}
							><Ellipsis class="size-5" /></IconButton
						>
					{/snippet}
				</Menu>
			{:else}
				<Button onclick={startConnect}
					><Plus class="size-4" aria-hidden="true" />{t('connect')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="grid gap-5">
		{#if connected}
			<Card rows>
				<Row title={addressText(connected)} meta={t('fact_address')} />
				{#if connected.name}<Row title={connected.name} meta={t('fact_name')} />{/if}
				{#if connected.version}<Row title={connected.version} meta={t('fact_version')} />{/if}
				{#if connected.checkedAt !== null}
					<Row title={when(connected.checkedAt)} meta={t('fact_checked')} />
				{/if}
			</Card>
			<Notice
				tone={connected.status === 'ok' || connected.status === 'checking' ? 'info' : 'alert'}
			>
				<strong
					>{t(STATUS_TEXT[connected.status])}{connected.status === 'checking' ? '' : '.'}</strong
				>
				{advice(connected)}
			</Notice>
		{:else}
			<Card variant="quiet" pad>
				<p class="font-semibold">{t('none')}</p>
				<p class="text-ink-soft mt-1 max-w-prose text-sm">{t('none_hint')}</p>
			</Card>
		{/if}
	</div>
</Page>

<SidePanel
	open={panelOpen}
	title={connected ? t('change_title') : t('connect_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('connect_save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	onclose={() => (panelOpen = false)}
	dirty={panelOpen && (token !== '' || address !== (connected ? addressText(connected) : ''))}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
>
	<form
		class="grid gap-5"
		bind:this={formEl}
		onsubmit={submit}
		aria-label={connected ? t('change_title') : t('connect_title')}
	>
		<div class="grid gap-1.5">
			<Label for="ha-address">{t('field_address')}</Label>
			<Input
				id="ha-address"
				bind:value={address}
				maxlength={2000}
				inputmode="url"
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				placeholder="http://192.168.1.20:8123"
				{...fieldAria(showErrors ? errors.address : undefined, 'ha-address')}
			/>
			<FieldError for="ha-address" error={showErrors ? errors.address : undefined} />
			<p class="text-ink-soft text-[13px]">{t('address_hint')}</p>
		</div>
		<div class="grid gap-1.5">
			<Label for="ha-token">{t('field_token')}</Label>
			<Input
				id="ha-token"
				type="password"
				bind:value={token}
				maxlength={1024}
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				{...fieldAria(showErrors ? errors.token : undefined, 'ha-token')}
			/>
			<FieldError for="ha-token" error={showErrors ? errors.token : undefined} />
			<p class="text-ink-soft text-[13px]">{t('token_hint')}</p>
			{#if connected}<p class="text-ink-soft text-[13px]">{t('token_change_hint')}</p>{/if}
		</div>
		{#if failed}<p class="text-attention text-sm font-semibold" role="alert">{t('error')}</p>{/if}
	</form>
</SidePanel>

<Dialog
	open={disconnecting}
	title={t('disconnect_title')}
	description={t('disconnect_hint')}
	onclose={() => (disconnecting = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (disconnecting = false)}
			>{t('cancel')}</Button
		>
		<Button variant="danger" data-armed="true" onclick={forget}>{t('disconnect')}</Button>
	{/snippet}
</Dialog>
