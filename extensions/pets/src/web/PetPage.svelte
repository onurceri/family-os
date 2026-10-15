<script lang="ts">
	import { formatDate } from '@famos/time';
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
	import { ArrowLeft, Archive, PawPrint, Pencil } from '@lucide/svelte';
	import { PET_AUDIENCE, type Pet, presetsFor, RECORD_KIND } from '../contract/index.js';
	import { archivePet, loadPet, type Outcome, updatePet } from './data.js';
	import { emptyPet, fromPet, toValues, validate, type PetFormValue } from './form.js';
	import { usePets } from './i18n.js';
	import { openPath } from './nav.js';
	import RecordMenu from './RecordMenu.svelte';
	import PetForm from './PetForm.svelte';
	import PetTreatments from './PetTreatments.svelte';
	import PetsShell from './PetsShell.svelte';

	/**
	 * The Pets page (`/pets`) and one pet's page (`/pets/:id`): its head (facts, who looks after it, Edit and the menu),
	 * then the sections that other extensions contribute to a record page (what needs doing,
	 * papers, costs), then the service log.
	 */
	let { params }: { params: Record<string, string> } = $props();
	const { app, t } = usePets();

	const petId = $derived(params.id ?? '');
	let pet = $state<Pet | null>(null);
	let missing = $state(false);
	let loadError = $state(false);
	async function load() {
		// A slower answer for the record chosen before must not replace this one.
		const id = petId;
		// The list alone (`/pets`): nothing chosen yet.
		if (!id) {
			pet = null;
			missing = false;
			loadError = false;
			return;
		}
		try {
			const loaded = await loadPet(id);
			if (id !== petId) return;
			pet = loaded;
			missing = false;
			loadError = false;
		} catch (error) {
			if (id !== petId) return;
			pet = null;
			// A pet that was archived (or never existed) answers 404; anything else is a failure.
			const status = (error as { status?: number }).status;
			missing = status === 404 || status === 400;
			loadError = !missing;
		}
	}
	$effect(() => {
		void petId;
		void load();
		return app.onEvent('pets.', () => void load());
	});

	// Also for people who may only suggest a change: theirs waits for approval.
	const mayChange = $derived(app.mayChange('pets.edit'));
	const report = (outcome: Outcome, message: string) => {
		if (outcome === 'drafted') app.sentForApproval();
		else app.toast(message);
	};

	// Editing: a panel (a sheet on phones), reflected as `?edit=1`.
	const editing = $derived(mayChange && Boolean(petId) && app.query().get('edit') === '1');
	const setEditing = (on: boolean) => app.setQuery({ edit: on ? '1' : null }, { replace: !on });
	let form = $state<PetFormValue>(emptyPet());
	let baseline = $state('');
	let showErrors = $state(false);
	let busy = $state(false);
	let formEl = $state<HTMLFormElement>();
	let formReady = false;
	const errors = $derived(showErrors ? validate(form) : {});
	const dirty = $derived(editing && JSON.stringify(form) !== baseline);
	// A fresh form from the pet each time the panel opens; later reloads do not overwrite typing.
	$effect(() => {
		if (!editing) {
			formReady = false;
			return;
		}
		if (formReady || !pet) return;
		form = fromPet(pet);
		baseline = JSON.stringify(form);
		showErrors = false;
		formReady = true;
	});
	async function save(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!pet || Object.keys(validate(form)).length) return;
		busy = true;
		try {
			report(await updatePet(pet.id, toValues(form)), t('saved'));
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
		if (!pet) return;
		try {
			const outcome = await archivePet(pet.id);
			report(outcome, t('archived'));
			if (outcome === 'applied') openPath('/pets');
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

	const caretakers = $derived(app.members().filter((m) => pet?.memberIds.includes(m.id)));
	const dateOf = (d: string) =>
		formatDate(d, app.dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
	const facts = $derived(
		pet
			? [
					t(`species_${pet.species}`),
					pet.breed,
					pet.sex ? t(`sex_${pet.sex}`) : null,
					pet.birthDate ? `${t('born')} ${dateOf(pet.birthDate)}` : null,
					pet.chipNumber ? `${t('field_chip')} ${pet.chipNumber}` : null,
					pet.vet ? `${t('field_vet')}: ${pet.vet}` : null,
				]
			: [],
	);
</script>

{#snippet pencil()}<Pencil class="size-4" />{/snippet}
{#snippet box()}<Archive class="size-4" />{/snippet}

{#snippet actionButtons()}
	{#if mayChange && pet}
		<Button variant="outline" onclick={() => setEditing(true)}
			><Pencil class="size-4" aria-hidden="true" />{t('edit')}</Button
		>
		<RecordMenu
			name={pet.name}
			label={t('options_for', { name: pet.name })}
			cancelLabel={t('cancel')}
			items={menu}
		/>
	{/if}
{/snippet}

<PetsShell selectedId={petId}>
	{#snippet item()}
		<div class="mb-3 flex items-center gap-2 lg:hidden">
			<Button variant="ghost" size="icon-sm" href="/pets" aria-label={t('back')}
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
		{:else if pet}
			<RecordHeader
				name={pet.name}
				recordId={pet.id}
				{facts}
				actions={wide.current ? actionButtons : undefined}
			>
				{#snippet icon()}<PawPrint />{/snippet}
				{#snippet people()}
					{#if caretakers.length > 0}
						<span class="flex -space-x-2">
							{#each caretakers as m (m.id)}
								<span class="ring-wall rounded-full ring-2"
									><Avatar name={m.displayName} color={m.color} size={26} /></span
								>
							{/each}
						</span>
						<span class="sr-only"
							>{t('caretakers')}: {caretakers.map((m) => m.displayName).join(', ')}</span
						>
					{/if}
				{/snippet}
			</RecordHeader>

			<div class="grid gap-7">
				{#if pet.notes}<p class="text-ink-soft max-w-prose break-words">{pet.notes}</p>{/if}

				<Slot
					name="record.section"
					props={{
						recordId: pet.id,
						recordKind: RECORD_KIND,
						recordName: pet.name,
						recordUrl: `/pets/${pet.id}`,
						audience: PET_AUDIENCE,
						presets: presetsFor(pet.species),
					}}
				/>

				<PetTreatments {pet} />
			</div>
		{/if}
	{/snippet}
</PetsShell>

<SidePanel
	note={app.needsApproval('pets.edit') ? app.t('app:draft_approval_note') : undefined}
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
		<PetForm bind:value={form} {errors} idPrefix="edit-pet" />
	</form>
</SidePanel>

<Dialog
	open={archiving}
	title={t('archive_title', { name: pet?.name ?? '' })}
	description={t('archive_hint')}
	onclose={() => (archiving = false)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (archiving = false)}>{t('cancel')}</Button
		>
		<Button variant="danger" data-armed="true" onclick={archive}>{t('archive_do')}</Button>
	{/snippet}
</Dialog>
