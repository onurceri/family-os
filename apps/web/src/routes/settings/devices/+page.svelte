<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import {
		Card,
		ConfirmButton,
		EmptyState,
		IconButton,
		Page,
		PageHeader,
		Pill,
		Row,
		Section,
		SidePanel,
		wide,
	} from '@famos/ui/famos';
	import { ChevronRight, Monitor, Plus, Smartphone, Tablet } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import Slot from '@famos/ui/slot';
	import { contributions } from '#lib/extensions.js';
	import { dateTimeFormat } from '#lib/format.svelte.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { onEvent } from '#lib/realtime.js';
	import { session } from '#lib/session.svelte.js';
	import { familyModeCapabilities } from '#lib/today/today-data.svelte.js';
	import AddDevice, { type AddStart } from './AddDevice.svelte';
	import DisplayForm from './DisplayForm.svelte';
	import { displayOptions } from './display-options.js';

	/**
	 * Devices: this device in one sentence and one button; one list of the
	 * family's devices (family tablets and phones, and screens), each opening its panel; "Add a
	 * device" asks what is being added and walks through numbered steps. A display's pairing link
	 * (`?code=`) opens that sheet at the screen's steps with the code filled. Photos and the weather
	 * have their own page.
	 */
	type Device = {
		id: string;
		name: string;
		kind: 'family' | 'kiosk';
		createdAt: number;
		lastSeenAt: number;
		display: { capabilities: string[]; showNames: boolean } | null;
	};
	type Option = { id: string; label: string };

	let devices = $state<Device[]>([]);
	let current = $state<{ id: string; name: string } | null>(null);
	let loaded = $state(false);
	let error = $state<string | null>(null);

	let allOptions = $state<Option[]>([]);
	/** Until the options are in, pairing would send no capabilities at all. */
	let optionsLoaded = $state(false);
	// Only what a display can show: a capability is offered when the display's Today (family
	// mode), a display widget, a status pill or ambient mode needs it (`requires`).
	const { offered: shown, optIn } = displayOptions(familyModeCapabilities(), contributions.slots);
	const options = $derived(allOptions.filter((o) => shown.has(o.id)));

	// Adding a device. A display's pairing link (`?code=`) opens the sheet at the screen's steps.
	let adding = $state(false);
	let start = $state<AddStart>(null);
	const linkCode = $derived(page.url.searchParams.get('code'));
	$effect(() => {
		if (linkCode === null) return;
		start = { kind: 'screen', code: linkCode };
		adding = true;
	});

	function openAdd(from: AddStart = null) {
		start = from;
		adding = true;
	}

	function closeAdd() {
		adding = false;
		if (linkCode !== null) void goto('/settings/devices', { replace: true });
	}

	// The device panels: a screen is edited, a family device is only read and removed.
	let openId = $state<string | null>(null);
	let editName = $state('');
	let editCaps = $state<string[]>([]);
	let editNames = $state(false);
	let editError = $state<string | null>(null);
	let editForm = $state<HTMLFormElement>();

	const opened = $derived(devices.find((d) => d.id === openId));
	const thisTrusted = $derived(current !== null);
	const editDirty = $derived(
		opened?.kind === 'kiosk' &&
			(editName !== opened.name ||
				editNames !== (opened.display?.showNames ?? false) ||
				[...editCaps].sort().join() !== [...(opened.display?.capabilities ?? [])].sort().join()),
	);

	const when = (ms: number) =>
		dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(ms);
	/** The day only, so a row's meta fits a phone. */
	const day = (ms: number) => dateTimeFormat({ dateStyle: 'medium' }).format(ms);
	const kindLabel = (d: Device) =>
		d.kind === 'kiosk' ? t('devices_kind_screen') : t('devices_trusted_badge');

	async function load() {
		const [list, mine] = await Promise.all([
			api.GET('/api/v1/core/devices'),
			api.GET('/api/v1/core/devices/current'),
		]);
		devices = list.data ?? [];
		current = mine.data?.device ?? null;
		if (!optionsLoaded) {
			const caps = await api.GET('/api/v1/core/displays/capabilities');
			allOptions = (caps.data ?? []).map((c) => ({ id: c.id, label: tDynamic(c.label) }));
			optionsLoaded = true;
		}
		loaded = true;
	}

	$effect(() => {
		if (session.status === 'ready' && !session.can('core.devices.manage'))
			void goto('/', { replace: true });
	});

	$effect(() => {
		if (!session.can('core.devices.manage')) return;
		void load();
		return onEvent('core.device.', () => void load());
	});

	function openDevice(device: Device) {
		openId = device.id;
		editName = device.name;
		editCaps = [...(device.display?.capabilities ?? [])];
		editNames = device.display?.showNames ?? false;
		editError = null;
	}

	async function saveDisplay() {
		if (!openId) return;
		editError = null;
		try {
			unwrap(
				await api.PATCH('/api/v1/core/displays/{deviceId}', {
					params: { path: { deviceId: openId } },
					body: { name: editName, capabilities: editCaps, showNames: editNames },
				}),
			);
			openId = null;
			await load();
		} catch {
			editError = t('error_generic');
		}
	}

	async function forget() {
		error = null;
		try {
			unwrap(await api.POST('/api/v1/core/devices/forget'));
			await load();
		} catch {
			error = t('error_generic');
		}
	}

	async function remove(id: string) {
		error = null;
		try {
			unwrap(
				await api.DELETE('/api/v1/core/devices/{deviceId}', { params: { path: { deviceId: id } } }),
			);
			openId = null;
			await load();
		} catch {
			error = t('error_generic');
		}
	}

	const discard = $derived({
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	});
</script>

{#snippet removeButton()}
	{#if opened}
		<ConfirmButton
			label={t('devices_revoke')}
			confirmLabel={t('devices_revoke_confirm')}
			onconfirm={() => remove(opened.id)}
		/>
	{/if}
{/snippet}

<Page template="settings">
	<PageHeader title={t('nav_devices_displays')}>
		{#snippet actions()}
			{#if wide.current}
				<Button variant="primary" onclick={() => openAdd()}
					><Plus aria-hidden="true" />{t('devices_add')}</Button
				>
			{:else}
				<IconButton variant="primary" label={t('devices_add')} onclick={() => openAdd()}>
					<Plus class="size-5" aria-hidden="true" />
				</IconButton>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="grid gap-7">
		<Section label={t('devices_this')}>
			<Card rows data-testid="this-device">
				<Row
					wrap
					title={current
						? t('devices_this_trusted', { name: current.name })
						: t('devices_this_untrusted')}
					meta={t('devices_trust_hint')}
				>
					{#snippet lead()}<Tablet class="size-5" aria-hidden="true" />{/snippet}
					{#snippet trail()}
						{#if current}
							<Button size="sm" variant="ghost" onclick={forget}>{t('devices_forget_short')}</Button
							>
						{:else}
							<Button size="sm" variant="secondary" onclick={() => openAdd({ kind: 'shared' })}
								>{t('devices_trust')}</Button
							>
						{/if}
					{/snippet}
				</Row>
			</Card>
		</Section>

		{#if devices.length > 0}
			<Section label={t('devices_list')} count={devices.length}>
				<Card rows data-testid="device-list">
					{#each devices as device (device.id)}
						<Row
							title={device.id === current?.id
								? `${device.name} · ${t('devices_this_short')}`
								: device.name}
							meta={t('devices_last_used', { when: day(device.lastSeenAt) })}
							onclick={() => openDevice(device)}
							aria-label={device.name}
							data-testid="device-row"
						>
							{#snippet lead()}
								{#if device.kind === 'kiosk'}<Monitor class="size-5" aria-hidden="true" />
								{:else}<Smartphone class="size-5" aria-hidden="true" />{/if}
							{/snippet}
							{#snippet trail()}
								<Pill>{kindLabel(device)}</Pill>
								<ChevronRight class="text-ink-soft size-4" aria-hidden="true" />
							{/snippet}
						</Row>
					{/each}
				</Card>
			</Section>
		{:else if loaded}
			<EmptyState art="devices" title={t('devices_none')} hint={t('devices_none_hint')}
			></EmptyState>
		{/if}
		{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}

		<!-- Where else the family chooses what displays show (photos and the weather). -->
		<Slot name="settings.display" />
	</div>

	<AddDevice
		open={adding}
		{start}
		{options}
		{optIn}
		{optionsLoaded}
		{thisTrusted}
		onclose={closeAdd}
		onchanged={() => void load()}
	/>

	<!-- A screen is edited (Save, Cancel, Remove); a family device is only read and removed. -->
	<SidePanel
		open={opened !== undefined}
		title={opened?.name ?? ''}
		closeLabel={t('side_panel_close')}
		cancelLabel={t('cancel')}
		saveLabel={t('save')}
		onsave={opened?.kind === 'kiosk' ? () => editForm?.requestSubmit() : undefined}
		danger={opened?.kind === 'kiosk' ? removeButton : undefined}
		footer={opened?.kind === 'family' ? removeButton : undefined}
		onclose={() => (openId = null)}
		dirty={editDirty}
		{discard}
	>
		{#if opened?.kind === 'kiosk'}
			<DisplayForm
				idPrefix="edit"
				options={allOptions.filter((o) => shown.has(o.id) || editCaps.includes(o.id))}
				bind:form={editForm}
				bind:name={editName}
				bind:capabilities={editCaps}
				bind:showNames={editNames}
				error={editError}
				onsubmit={saveDisplay}
			/>
		{:else if opened}
			<div class="grid gap-3 text-sm">
				<p>{t('devices_family_about')}</p>
				<p class="text-ink-soft">
					{t('devices_added', { when: when(opened.createdAt) })}<br />
					{t('devices_last_used', { when: when(opened.lastSeenAt) })}
				</p>
			</div>
		{/if}
	</SidePanel>
</Page>
