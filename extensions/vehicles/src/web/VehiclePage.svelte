<script lang="ts">
	import { Button } from '@famos/ui/button';
	import {
		Avatar,
		Dialog,
		PageHeader,
		RecordHeader,
		SidePanel,
		type MenuItem,
		wide,
	} from '@famos/ui/famos';
	import Slot from '@famos/ui/slot';
	import { ArrowLeft, Archive, Car, Pencil } from '@lucide/svelte';
	import {
		RECORD_KIND,
		VEHICLE_AUDIENCE,
		VEHICLE_PRESETS,
		type Vehicle,
	} from '../contract/index.js';
	import { archiveVehicle, loadVehicle, type Outcome, updateVehicle } from './data.js';
	import { emptyVehicle, fromVehicle, toValues, validate, type VehicleFormValue } from './form.js';
	import { useVehicles } from './i18n.js';
	import { openPath } from './nav.js';
	import RecordMenu from './RecordMenu.svelte';
	import VehicleForm from './VehicleForm.svelte';
	import VehicleLogs from './VehicleLogs.svelte';
	import VehiclesShell from './VehiclesShell.svelte';

	/**
	 * The Vehicles page (`/vehicles`) and one vehicle's page (`/vehicles/:id`): its head (facts, who drives it, Edit and the menu),
	 * then the sections that other extensions contribute to a record page (what needs doing,
	 * papers, costs), then the service log.
	 */
	let { params }: { params: Record<string, string> } = $props();
	const { app, t } = useVehicles();

	const vehicleId = $derived(params.id ?? '');
	let vehicle = $state<Vehicle | null>(null);
	let missing = $state(false);
	let loadError = $state(false);
	async function load() {
		// A slower answer for the record chosen before must not replace this one.
		const id = vehicleId;
		// The list alone (`/vehicles`): nothing chosen yet.
		if (!id) {
			vehicle = null;
			missing = false;
			loadError = false;
			return;
		}
		try {
			const loaded = await loadVehicle(id);
			if (id !== vehicleId) return;
			vehicle = loaded;
			missing = false;
			loadError = false;
		} catch (error) {
			if (id !== vehicleId) return;
			vehicle = null;
			// A vehicle that was archived (or never existed) answers 404; anything else is a failure.
			const status = (error as { status?: number }).status;
			missing = status === 404 || status === 400;
			loadError = !missing;
		}
	}
	$effect(() => {
		void vehicleId;
		void load();
		return app.onEvent('vehicles.', () => void load());
	});

	const canEdit = $derived(app.can('vehicles.edit'));
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};

	// Editing: a panel (a sheet on phones), reflected as `?edit=1`.
	const editing = $derived(canEdit && Boolean(vehicleId) && app.query().get('edit') === '1');
	const setEditing = (on: boolean) => app.setQuery({ edit: on ? '1' : null }, { replace: !on });
	let form = $state<VehicleFormValue>(emptyVehicle());
	let baseline = $state('');
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let formReady = false;
	const errors = $derived(showErrors ? validate(form) : {});
	const dirty = $derived(editing && JSON.stringify(form) !== baseline);
	// A fresh form from the vehicle each time the panel opens; later reloads do not overwrite typing.
	$effect(() => {
		if (!editing) {
			formReady = false;
			return;
		}
		if (formReady || !vehicle) return;
		form = fromVehicle(vehicle);
		baseline = JSON.stringify(form);
		showErrors = false;
		formReady = true;
	});
	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!vehicle || Object.keys(validate(form)).length) return;
		busy = true;
		try {
			report(await updateVehicle(vehicle.id, toValues(form)), t('saved'));
			setEditing(false);
			await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	// Archiving asks first, in a dialog (the action sits in a menu).
	let archiving = $state(false);
	async function archive() {
		archiving = false;
		if (!vehicle) return;
		try {
			const outcome = await archiveVehicle(vehicle.id);
			report(outcome, t('archived'));
			if (outcome === 'applied') openPath('/vehicles');
		} catch {
			app.toast(t('error'));
		}
	}
	const menu = $derived<MenuItem[]>([
		{ id: 'edit', label: t('edit'), icon: pencil, onselect: () => setEditing(true) },
		{
			id: 'archive',
			label: t('archive'),
			icon: box,
			danger: true,
			onselect: () => (archiving = true),
		},
	]);

	const drivers = $derived(app.members().filter((m) => vehicle?.memberIds.includes(m.id)));
	const facts = $derived(
		vehicle
			? [
					vehicle.plate,
					[vehicle.make, vehicle.model].filter(Boolean).join(' ') +
						(vehicle.year ? ` ${vehicle.year}` : ''),
					t(`fuel_${vehicle.fuel}`),
					vehicle.vin ? `${t('field_vin')} ${vehicle.vin}` : null,
				]
			: [],
	);
</script>

{#snippet pencil()}<Pencil class="size-4" />{/snippet}
{#snippet box()}<Archive class="size-4" />{/snippet}

{#snippet actionButtons()}
	{#if canEdit && vehicle}
		<Button variant="outline" onclick={() => setEditing(true)}
			><Pencil class="size-4" aria-hidden="true" />{t('edit')}</Button
		>
		<RecordMenu
			name={vehicle.name}
			label={t('options_for', { name: vehicle.name })}
			cancelLabel={t('cancel')}
			items={menu}
		/>
	{/if}
{/snippet}

<VehiclesShell selectedId={vehicleId}>
	{#snippet item()}
		<div class="mb-3 flex items-center gap-2 lg:hidden">
			<Button variant="ghost" size="icon-sm" href="/vehicles" aria-label={t('back')}
				><ArrowLeft class="size-5" aria-hidden="true" /></Button
			>
			{#if !wide.current}
				<span class="ms-auto flex items-center gap-2">{@render actionButtons()}</span>
			{/if}
		</div>

		{#if loadError}
			<p class="text-attention font-semibold" role="alert">{t('error')}</p>
		{:else if missing}
			<PageHeader title={t('not_found')} />
		{:else if vehicle}
			<RecordHeader
				name={vehicle.name}
				recordId={vehicle.id}
				{facts}
				actions={wide.current ? actionButtons : undefined}
			>
				{#snippet icon()}<Car />{/snippet}
				{#snippet people()}
					{#if drivers.length > 0}
						<span class="flex -space-x-2">
							{#each drivers as m (m.id)}
								<span class="ring-wall rounded-full ring-2"
									><Avatar name={m.displayName} color={m.color} size={26} /></span
								>
							{/each}
						</span>
						<span class="sr-only"
							>{t('drivers')}: {drivers.map((m) => m.displayName).join(', ')}</span
						>
					{/if}
				{/snippet}
			</RecordHeader>

			<div class="grid gap-7">
				{#if vehicle.notes}<p class="text-ink-soft max-w-prose break-words">{vehicle.notes}</p>{/if}

				<Slot
					name="record.section"
					props={{
						recordId: vehicle.id,
						recordKind: RECORD_KIND,
						recordName: vehicle.name,
						recordUrl: `/vehicles/${vehicle.id}`,
						audience: VEHICLE_AUDIENCE,
						presets: VEHICLE_PRESETS,
					}}
				/>

				<VehicleLogs {vehicle} />
			</div>
		{/if}
	{/snippet}
</VehiclesShell>

<SidePanel
	open={editing}
	title={t('form_title')}
	closeLabel={t('close')}
	cancelLabel={t('cancel')}
	saveLabel={t('save')}
	saveDisabled={busy}
	onsave={() => formEl?.requestSubmit()}
	{dirty}
	discard={{
		title: t('discard_title'),
		description: t('discard_hint'),
		keep: t('discard_keep'),
		discard: t('discard_confirm'),
	}}
	onclose={() => setEditing(false)}
>
	<form bind:this={formEl} onsubmit={save} aria-label={t('form_title')}>
		<VehicleForm bind:value={form} {errors} idPrefix="edit-vehicle" />
	</form>
</SidePanel>

<Dialog
	open={archiving}
	title={t('archive_title', { name: vehicle?.name ?? '' })}
	description={t('archive_hint')}
	onclose={() => (archiving = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (archiving = false)}>{t('cancel')}</Button
		>
		<Button variant="danger" data-armed="true" onclick={archive}>{t('archive_do')}</Button>
	{/snippet}
</Dialog>
