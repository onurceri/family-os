<script lang="ts" module>
	/** Where the sheet opens: a display's pairing link carries its code; "This device" starts at its step. */
	export type AddStart = { kind: 'screen' | 'shared'; code?: string } | null;
</script>

<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		FIELD_REASON,
		fieldAria,
		FieldError,
		focusFirstInvalid,
		Row,
		SidePanel,
		Step,
		Steps,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ChevronRight, Monitor, Tablet } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { t } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import QrCode from '#lib/QrCode.svelte';
	import DisplayForm from './DisplayForm.svelte';
	import { initialGrant } from './display-options.js';
	import { screenAddress } from './screen-address.js';

	/**
	 * "Add a device" (guided steps): first what is being added, then numbered steps. A
	 * screen for the wall: open the address on it, type the code it shows, choose what it may show,
	 * then wait until the screen has claimed the code, and only then say it is connected (the
	 * display's pairing screen says the same steps from its side). A tablet or phone the
	 * family shares: open FamilyOS on it, sign in once, make it a family device (the button itself
	 * when this browser is that device), done.
	 */
	type Kind = 'screen' | 'shared';
	type Option = { id: string; label: string };

	let {
		open,
		start = null,
		options,
		optIn,
		optionsLoaded,
		/** Whether this browser is already a family device (then it cannot be made one here). */
		thisTrusted,
		onclose,
		onchanged,
	}: {
		open: boolean;
		start?: AddStart;
		options: Option[];
		/** What a new screen starts without; the admin ticks it to add it. */
		optIn: ReadonlySet<string>;
		optionsLoaded: boolean;
		thisTrusted: boolean;
		onclose: () => void;
		/** A device was added: the page reloads its list. */
		onchanged: () => void;
	} = $props();

	let kind = $state<Kind | null>(null);
	let step = $state(1);
	let code = $state('');
	let name = $state('');
	let caps = $state<string[]>([]);
	let showNames = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);
	/** The name of what was added, for the last step. */
	let added = $state('');
	/** The confirmed code, until its screen claims it, and what the server says of it. */
	let pairingId = $state<string | null>(null);
	let pairing = $state<'waiting' | 'connected' | 'expired'>('waiting');
	/** A screen asked with the code lately; after a few seconds without one, the admin is told. */
	let answering = $state(true);
	let waitedLong = $state(false);
	let screenForm = $state<HTMLFormElement>();
	// The device name's reason shows from the first refused submit on, and goes once it is typed.
	let triedName = $state(false);
	const nameError = $derived(triedName && !name.trim() ? FIELD_REASON.name : undefined);
	/** The checklist is filled once per opening, when the options are in. */
	let capsFilled = $state(false);

	const origin = typeof location === 'undefined' ? '' : location.origin;
	/** The address the server was told the family uses at home (`FAMOS_BASE_URL`), once asked. */
	let familyAddress = $state<string | null>(null);
	const reach = $derived(screenAddress(origin, familyAddress));
	// A loopback address is no use on another device: the family address replaces it, or nothing does.
	const displayAddress = $derived(`${reach.url ?? origin}/display`);
	/** What the waiting texts name: the page's path when no address can be given. */
	const spokenAddress = $derived(reach.url ? displayAddress : '/display');

	// Each opening starts fresh, where the page asks.
	$effect(() => {
		if (!open) return;
		kind = start?.kind ?? null;
		code = start?.code ?? '';
		// A code from the display's link: the first two steps are done.
		step = start?.kind === 'screen' && start.code ? 3 : start?.kind === 'shared' ? 3 : 1;
		name = '';
		showNames = false;
		error = null;
		added = '';
		pairingId = null;
		capsFilled = false;
		triedName = false;
	});
	$effect(() => {
		if (!open || !reach.loopback) return;
		void api.GET('/api/v1/core/devices/address').then((res) => {
			familyAddress = res.data?.url ?? null;
		});
	});
	// What makes up the day is ticked at first, and the admin unticks what it should not; the rest
	// (a status pill) is theirs to add.
	$effect(() => {
		if (!open || !optionsLoaded || capsFilled) return;
		caps = initialGrant(options, optIn);
		capsFilled = true;
	});

	function choose(next: Kind) {
		kind = next;
		step = 1;
		error = null;
	}

	function back() {
		kind = null;
		step = 1;
	}

	/** A done step opens again, until the flow is finished. */
	function reopen(n: number) {
		if (step < 4) step = n;
	}

	async function connect() {
		error = null;
		busy = true;
		try {
			const result = unwrap(
				await api.POST('/api/v1/actions/core.confirmDisplayPairing', {
					body: { userCode: code.trim(), name, capabilities: caps, showNames },
				}),
			);
			if (result.status !== 'applied') throw new Error('not applied');
			const done = result.output;
			added = done.name;
			pairingId = done.pairingId;
			pairing = 'waiting';
			answering = true;
			waitedLong = false;
			step = 4;
		} catch (e) {
			const badCode = typeof e === 'object' && e !== null && 'status' in e && e.status === 404;
			error = badCode ? t('devices_display_bad_code') : t('error_generic');
			// A code typed wrong (or run out): back to the step where it is typed.
			if (badCode) step = 2;
		} finally {
			busy = false;
		}
	}

	/** Asks whether the screen has claimed the code yet; a new device is the page's to list. */
	async function checkPairing() {
		const id = pairingId;
		if (!id || pairing !== 'waiting') return;
		const res = await api.GET('/api/v1/core/displays/pairings/{pairingId}', {
			params: { path: { pairingId: id } },
		});
		if (!res.data || id !== pairingId) return;
		pairing = res.data.status;
		answering = res.data.status === 'waiting' ? res.data.answering : true;
		if (res.data.status === 'connected') onchanged();
	}

	// The screen claims the code on its next poll (every few seconds); the device's event usually
	// says so first, and asking every two seconds covers a lost one.
	$effect(() => {
		if (!open || !pairingId || pairing !== 'waiting') return;
		const timer = setInterval(() => void checkPairing(), 2000);
		// A screen asks every five seconds; after a restart of the server it is not known to ask
		// until its next poll, so silence is said only after a while.
		const patience = setTimeout(() => (waitedLong = true), 8000);
		const off = onEvent('core.device.', () => void checkPairing());
		return () => {
			clearInterval(timer);
			clearTimeout(patience);
			off();
		};
	});

	/** The code ran out: the screen shows a new one, typed in the code step. */
	function typeNewCode() {
		pairingId = null;
		code = '';
		error = null;
		step = 2;
	}

	async function trust() {
		error = null;
		busy = true;
		try {
			unwrap(await api.POST('/api/v1/core/devices/trust', { body: { name } }));
			added = name;
			step = 4;
			onchanged();
		} catch {
			error = t('error_generic');
		} finally {
			busy = false;
		}
	}

	const title = $derived(
		kind === 'screen'
			? t('devices_add_screen_title')
			: kind === 'shared'
				? t('devices_add_shared_title')
				: t('devices_add'),
	);
	const discard = $derived({
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	});
</script>

{#snippet loopbackNote()}
	{#if reach.loopback}
		<p class="text-attention text-sm font-semibold" data-testid="loopback-note">
			{t('devices_loopback_note')}
		</p>
	{/if}
{/snippet}

<SidePanel
	{open}
	{title}
	closeLabel={t('side_panel_close')}
	cancelLabel={step === 4 ? t('devices_close') : t('cancel')}
	{onclose}
	dirty={step === 3 && name !== ''}
	{discard}
>
	<div class="grid gap-5" data-testid="add-device">
		{#if kind === null}
			<p class="text-[17px] font-bold">{t('devices_add_what')}</p>
			<Card rows>
				<Row
					wrap
					title={t('devices_add_screen')}
					meta={t('devices_add_screen_hint')}
					onclick={() => choose('screen')}
				>
					{#snippet lead()}<Monitor class="size-6" aria-hidden="true" />{/snippet}
					{#snippet trail()}<ChevronRight
							class="text-ink-soft size-4"
							aria-hidden="true"
						/>{/snippet}
				</Row>
				<Row
					wrap
					title={t('devices_add_shared')}
					meta={t('devices_add_shared_hint')}
					onclick={() => choose('shared')}
				>
					{#snippet lead()}<Tablet class="size-6" aria-hidden="true" />{/snippet}
					{#snippet trail()}<ChevronRight
							class="text-ink-soft size-4"
							aria-hidden="true"
						/>{/snippet}
				</Row>
			</Card>
		{:else if kind === 'screen'}
			<Steps
				current={step}
				onselect={step < 4 ? reopen : undefined}
				label={t('devices_add_screen')}
				doneLabel={t('steps_done')}
			>
				<Step
					n={1}
					title={t('devices_screen_step_open')}
					summary={reach.url ? displayAddress : undefined}
				>
					<p class="text-ink-soft text-sm">{t('devices_screen_open_body')}</p>
					{#if reach.url}
						<p class="text-info text-lg font-bold break-all" data-testid="display-address">
							{displayAddress}
						</p>
					{/if}
					{@render loopbackNote()}
					{#if reach.url}
						<div class="flex items-center gap-4">
							<QrCode text={displayAddress} label={t('devices_screen_qr')} class="w-28 shrink-0" />
							<p class="text-ink-soft text-[13px]">{t('devices_screen_qr_hint')}</p>
						</div>
					{/if}
					<div class="flex flex-wrap gap-2">
						<Button variant="primary" onclick={() => (step = 2)}>{t('devices_next')}</Button>
						<Button variant="ghost" onclick={back}>{t('devices_back')}</Button>
					</div>
				</Step>
				<Step
					n={2}
					title={t('devices_screen_step_code')}
					summary={code ? t('devices_screen_code_summary', { code: code.trim() }) : undefined}
				>
					<form
						class="grid gap-3"
						onsubmit={(e) => {
							e.preventDefault();
							error = null;
							step = 3;
						}}
					>
						<div class="grid gap-1.5">
							<Label for="pair-code">{t('devices_display_code')}</Label>
							<Input
								id="pair-code"
								bind:value={code}
								required
								maxlength={12}
								autocomplete="off"
								autocapitalize="characters"
								placeholder="ABCD-EFGH"
								class="font-mono tracking-widest uppercase"
							/>
							<small class="text-ink-soft text-[13px]">{t('devices_display_code_hint')}</small>
						</div>
						{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
						<div><Button type="submit" variant="primary">{t('devices_next')}</Button></div>
					</form>
				</Step>
				<Step n={3} title={t('devices_screen_step_choose')}>
					<DisplayForm
						idPrefix="pair"
						{options}
						bind:form={screenForm}
						bind:name
						bind:capabilities={caps}
						bind:showNames
						{error}
						onsubmit={connect}
					/>
					<div>
						<Button
							variant="primary"
							disabled={!optionsLoaded || busy}
							onclick={() => screenForm?.requestSubmit()}>{t('devices_display_confirm')}</Button
						>
					</div>
				</Step>
				<Step
					n={4}
					title={pairing === 'connected'
						? t('devices_step_done')
						: pairing === 'expired'
							? t('devices_step_not_connected')
							: t('devices_step_waiting')}
				>
					<div class="grid gap-3" role="status" data-testid="pairing-status" data-state={pairing}>
						{#if pairing === 'connected'}
							<p>{t('devices_display_done', { name: added })}</p>
						{:else if pairing === 'expired'}
							<p>{t('devices_display_expired', { name: added })}</p>
						{:else}
							<p>{t('devices_display_waiting', { name: added, address: spokenAddress })}</p>
							{#if waitedLong && !answering}
								<p class="text-attention text-sm font-semibold">
									{t('devices_display_not_answering', {
										code: code.trim().toUpperCase(),
										address: spokenAddress,
									})}
								</p>
							{/if}
						{/if}
					</div>
					<div>
						{#if pairing === 'expired'}
							<Button variant="primary" onclick={typeNewCode}
								>{t('devices_display_new_code')}</Button
							>
						{:else}
							<Button variant={pairing === 'connected' ? 'primary' : 'ghost'} onclick={onclose}
								>{t('devices_close')}</Button
							>
						{/if}
					</div>
				</Step>
			</Steps>
		{:else}
			<Steps
				current={step}
				onselect={step < 4 ? reopen : undefined}
				label={t('devices_add_shared')}
				doneLabel={t('steps_done')}
			>
				<Step n={1} title={t('devices_shared_step_open')} summary={reach.url ?? undefined}>
					<p class="text-ink-soft text-sm">{t('devices_shared_open_body')}</p>
					{#if reach.url}
						<p class="text-info text-lg font-bold break-all">{reach.url}</p>
					{/if}
					{@render loopbackNote()}
					<div class="flex flex-wrap gap-2">
						<Button variant="primary" onclick={() => (step = 2)}>{t('devices_next')}</Button>
						<Button variant="ghost" onclick={back}>{t('devices_back')}</Button>
					</div>
				</Step>
				<Step n={2} title={t('devices_shared_step_sign_in')}>
					<p class="text-ink-soft text-sm">{t('devices_shared_sign_in_body')}</p>
					<div>
						<Button variant="primary" onclick={() => (step = 3)}>{t('devices_next')}</Button>
					</div>
				</Step>
				<Step n={3} title={t('devices_shared_step_trust')}>
					{#if thisTrusted}
						<p class="text-ink-soft text-sm">{t('devices_shared_trust_there')}</p>
						<div><Button variant="primary" onclick={onclose}>{t('devices_got_it')}</Button></div>
					{:else}
						<p class="text-ink-soft text-sm">{t('devices_shared_trust_here')}</p>
						<form
							class="grid gap-3"
							novalidate
							onsubmit={(e) => {
								e.preventDefault();
								triedName = true;
								if (!name.trim()) {
									void focusFirstInvalid(e.currentTarget);
									return;
								}
								void trust();
							}}
						>
							<div class="grid gap-1.5">
								<Label for="device-name">{t('devices_name')}</Label>
								<Input
									id="device-name"
									bind:value={name}
									required
									maxlength={60}
									placeholder={t('devices_name_placeholder')}
									{...fieldAria(nameError, 'device-name')}
								/>
								<FieldError for="device-name" error={nameError} />
							</div>
							{#if error}<p class="text-attention text-sm font-semibold" role="alert">
									{error}
								</p>{/if}
							<div>
								<Button type="submit" variant="primary" disabled={busy}>{t('devices_trust')}</Button
								>
							</div>
						</form>
						<p class="text-ink-soft text-[13px]">{t('devices_shared_trust_elsewhere')}</p>
					{/if}
				</Step>
				<Step n={4} title={t('devices_step_done')}>
					<p role="status">{t('devices_shared_done', { name: added })}</p>
					<div><Button variant="primary" onclick={onclose}>{t('devices_close')}</Button></div>
				</Step>
			</Steps>
		{/if}
	</div>
</SidePanel>
