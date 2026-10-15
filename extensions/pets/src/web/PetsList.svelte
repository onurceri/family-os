<script lang="ts">
	import { scheduleOfPick } from '@famos/ext-records/contract';
	import { SidePanel, Tile } from '@famos/ui/famos';
	import { PawPrint } from '@lucide/svelte';
	import { type Pet, type PresetId, presetsFor } from '../contract/index.js';
	import { addPet, loadPets } from './data.js';
	import {
		emptyPet,
		freshPicks,
		type PetFormValue,
		type PresetPicks,
		toValues,
		validate,
	} from './form.js';
	import { usePets } from './i18n.js';
	import { openPath } from './nav.js';
	import PetForm from './PetForm.svelte';

	/** The Pets page: the household's pets, and a form to add one with its usual duties. */
	let {
		selectedId = '',
		adding = false,
		onclosepanel,
		empty = $bindable(false),
		first = $bindable(),
		count = $bindable(0),
	}: {
		selectedId?: string;
		/** The page's add button opens the form (in a side panel, or a sheet on phones). */
		adding?: boolean;
		onclosepanel: () => void;
		/** Loaded and nothing there: the page shows its empty state. */
		empty?: boolean;
		/** Where the first one opens (the page opens it on wide windows). */
		first?: string | undefined;
		/** How many there are, for the page's one-item rule. */
		count?: number;
	} = $props();
	const { app, t } = usePets();

	let pets = $state<Pet[]>([]);
	let loadError = $state(false);
	async function load() {
		try {
			const loadedItems = await loadPets();
			pets = loadedItems;
			empty = loadedItems.length === 0;
			count = loadedItems.length;
			first = loadedItems[0] ? `/pets/${loadedItems[0].id}` : undefined;
			loadError = false;
		} catch {
			loadError = true;
		}
	}
	$effect(() => {
		void load();
		return app.onEvent('pets.', () => void load());
	});

	let form = $state<PetFormValue>(emptyPet());
	let picks = $state<PresetPicks>(freshPicks());
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	// What the form held when it opened, to tell whether closing it would lose something.
	let baseline = $state('');
	const dirty = $derived(adding && JSON.stringify([form, picks]) !== baseline);
	// Only the duties suggested for the chosen species count.
	const chosen = $derived(presetsFor(form.species).filter((p) => picks[p.id].on));
	const errors = $derived.by(() => {
		if (!showErrors) return {};
		const found = validate(form);
		for (const preset of chosen) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(picks[preset.id].date)) found[`preset_${preset.id}`] = true;
		}
		return found;
	});

	// A fresh form each time the panel opens.
	$effect(() => {
		if (!adding) return;
		const fresh = emptyPet();
		const freshPick = freshPicks();
		form = fresh;
		picks = freshPick;
		showErrors = false;
		baseline = JSON.stringify([fresh, freshPick]);
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (Object.keys(errors).length || Object.keys(validate(form)).length) return;
		if (chosen.some((p) => !picks[p.id].date)) return;
		busy = true;
		try {
			const { outcome, id } = await addPet({
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
			if (id) openPath(`/pets/${id}`);
			else await load();
		} catch {
			app.toast(t('error'));
		} finally {
			busy = false;
		}
	}

	const summary = (p: Pet) => [t(`species_${p.species}`), p.breed].filter(Boolean).join(' · ');
</script>

<SidePanel
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
		<PetForm bind:value={form} bind:picks {errors} idPrefix="new-pet" />
	</form>
</SidePanel>

<div class="grid gap-4">
	{#if loadError}
		<p class="text-attention font-semibold" role="alert">{t('error')}</p>
	{/if}

	<ul class="grid gap-1.5">
		{#each pets as p (p.id)}
			<li>
				<Tile
					title={p.name}
					subtitle={summary(p)}
					href="/pets/{p.id}"
					selected={p.id === selectedId}
				>
					{#snippet lead()}
						<span class="bg-idle grid size-9 place-items-center rounded-full"
							><PawPrint class="size-[18px]" aria-hidden="true" /></span
						>
					{/snippet}
				</Tile>
			</li>
		{/each}
	</ul>
</div>
