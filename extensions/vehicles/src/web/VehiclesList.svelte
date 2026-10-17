<script lang="ts">
	import { scheduleOfPick } from '@famos/ext-records/contract';
	import { FIELD_REASON, focusFirstInvalid, SidePanel, Tile } from '@famos/ui/famos';
	import { Car } from '@lucide/svelte';
	import { VEHICLE_PRESETS, type PresetId, type Vehicle } from '../contract/index.js';
	import { addVehicle, loadVehicles } from './data.js';
	import {
		emptyVehicle,
		freshPicks,
		type PresetPicks,
		toValues,
		validate,
		type VehicleFormValue,
	} from './form.js';
	import { useVehicles } from './i18n.js';
	import { openPath } from './nav.js';
	import VehicleForm from './VehicleForm.svelte';

	/** The Vehicles page: the household's vehicles, and a form to add one with its usual duties. */
	let {
		selectedId = '',
		adding = false,
		onclosepanel,
		empty = $bindable(false),
		first = $bindable(),
		count = $bindable(0),
	}: {
		selectedId?: string;
		/** The page's "Add vehicle" opens the form (in a side panel, or a sheet on phones). */
		adding?: boolean;
		onclosepanel: () => void;
		/** Loaded and no vehicles: the page shows its empty state. */
		empty?: boolean;
		/** Where the first one opens (the page opens it on wide windows). */
		first?: string | undefined;
		/** How many there are, for the page's one-item rule. */
		count?: number;
	} = $props();
	const { app, t } = useVehicles();

	let vehicles = $state<Vehicle[]>([]);
	let loadError = $state(false);
	async function load() {
		try {
			vehicles = await loadVehicles();
			empty = vehicles.length === 0;
			count = vehicles.length;
			first = vehicles[0] ? `/vehicles/${vehicles[0].id}` : undefined;
			loadError = false;
		} catch {
			loadError = true;
		}
	}
	$effect(() => {
		void load();
		return app.onEvent('vehicles.', () => void load());
	});

	let form = $state<VehicleFormValue>(emptyVehicle());
	let picks = $state<PresetPicks>(freshPicks());
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	// What the form held when it opened, to tell whether closing it would lose something.
	let baseline = $state('');
	const dirty = $derived(adding && JSON.stringify([form, picks]) !== baseline);
	const errors = $derived.by(() => {
		if (!showErrors) return {};
		const found = validate(form);
		for (const preset of VEHICLE_PRESETS) {
			const pick = picks[preset.id];
			if (pick.on && !/^\d{4}-\d{2}-\d{2}$/.test(pick.date))
				found[`preset_${preset.id}`] = FIELD_REASON.date;
		}
		return found;
	});

	// A fresh form each time the panel opens.
	$effect(() => {
		if (!adding) return;
		const fresh = emptyVehicle();
		const freshPick = freshPicks();
		form = fresh;
		picks = freshPick;
		showErrors = false;
		baseline = JSON.stringify([fresh, freshPick]);
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		const found = validate(form);
		const chosen = VEHICLE_PRESETS.filter((p) => picks[p.id].on);
		if (Object.keys(found).length || chosen.some((p) => !picks[p.id].date)) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		busy = true;
		try {
			const { outcome, id } = await addVehicle({
				...toValues(form),
				obligations: chosen.map((p) => ({
					preset: p.id as PresetId,
					title: app.t(p.titleKey),
					dueDate: picks[p.id].date,
					...scheduleOfPick(picks[p.id]),
				})),
			});
			if (outcome === 'drafted') app.sentForApproval();
			else app.toast(t('saved'));
			onclosepanel();
			if (id) openPath(`/vehicles/${id}`);
			else await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	const summary = (v: Vehicle) =>
		[v.plate, [v.make, v.model].filter(Boolean).join(' '), v.year].filter(Boolean).join(' · ');
</script>

<SidePanel
	approval={app.approval('vehicles.addVehicle')}
	open={adding}
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
	onclose={onclosepanel}
>
	<form bind:this={formEl} onsubmit={submit} aria-label={t('form_title')}>
		<VehicleForm bind:value={form} bind:picks {errors} idPrefix="new-vehicle" />
	</form>
</SidePanel>

<div class="grid gap-4">
	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{/if}

	<ul class="grid gap-1.5">
		{#each vehicles as v (v.id)}
			<li>
				<Tile
					title={v.name}
					subtitle={summary(v)}
					href="/vehicles/{v.id}"
					selected={v.id === selectedId}
				>
					{#snippet lead()}
						<span class="bg-idle grid size-9 place-items-center rounded-full"
							><Car class="size-[18px]" aria-hidden="true" /></span
						>
					{/snippet}
				</Tile>
			</li>
		{/each}
	</ul>
</div>
