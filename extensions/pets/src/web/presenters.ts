import { type DraftPresenter, draftDate } from '@famos/ui/slots';
import { PawPrint, Syringe } from '@lucide/svelte';
import type { AddPetInput, AddTreatmentInput } from '../contract/index.js';

/** How a suggested pet reads in the Inbox. */
export const addPetPresenter: DraftPresenter<AddPetInput> = {
	actionId: 'pets.addPet',
	kind: (c) => c.t('pets:kind_pet'),
	icon: PawPrint,
	title: (input) => input.name,
	fields: (input, c) => [
		...(input.species
			? [
					{
						label: c.t('pets:draft_species'),
						value: c.t(`pets:species_${input.species}`),
						path: 'species',
					},
				]
			: []),
		...(input.birthDate
			? [{ label: c.t('pets:born'), value: draftDate(input.birthDate, c), path: 'birthDate' }]
			: []),
	],
	approveLabel: (c) => c.t('pets:draft_approve_add'),
};

/** A treatment, as the AI reads it from a vet card or receipt or a person suggests it. */
export const addTreatmentPresenter: DraftPresenter<AddTreatmentInput & { label?: string }> = {
	actionId: 'pets.addTreatment',
	kind: (c) => c.t('pets:kind_treatment'),
	icon: Syringe,
	// The pet's name on record (stored with the draft), else the one a model read.
	title: (input, c) => {
		const pet = input.label || input.petName;
		const kind = c.t(`pets:treatment_kind_${input.kind ?? 'vaccination'}`);
		return pet ? `${pet} · ${kind}` : kind;
	},
	fields: (input, c) => [
		{ label: c.t('pets:draft_date'), value: draftDate(input.givenOn, c), path: 'givenOn' },
		...(input.product
			? [{ label: c.t('pets:draft_product'), value: input.product, path: 'product' }]
			: []),
		...(input.batch ? [{ label: c.t('pets:draft_batch'), value: input.batch, path: 'batch' }] : []),
		...(input.vet ? [{ label: c.t('pets:draft_vet'), value: input.vet, path: 'vet' }] : []),
		...(input.notes ? [{ label: c.t('pets:draft_notes'), value: input.notes, path: 'notes' }] : []),
	],
	approveLabel: (c) => c.t('pets:draft_approve_treatment'),
};
