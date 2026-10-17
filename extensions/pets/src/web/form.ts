import { freshPick, type PresetPickState } from '@famos/ext-records/contract';
import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import {
	PET_PRESETS,
	type Pet,
	type PresetId,
	SEXES,
	type Sex,
	SPECIES,
	type Species,
} from '../contract/index.js';
import type { PetValues } from './data.js';

/** The pet form as the inputs hold it. */
export interface PetFormValue {
	name: string;
	species: Species;
	breed: string;
	/** Empty when not set. */
	sex: Sex | '';
	birthDate: string;
	chipNumber: string;
	vet: string;
	memberIds: string[];
	notes: string;
}

export const emptyPet = (): PetFormValue => ({
	name: '',
	species: 'cat',
	breed: '',
	sex: '',
	birthDate: '',
	chipNumber: '',
	vet: '',
	memberIds: [],
	notes: '',
});

export const fromPet = (p: Pet): PetFormValue => ({
	name: p.name,
	species: p.species,
	breed: p.breed,
	sex: p.sex ?? '',
	birthDate: p.birthDate ?? '',
	chipNumber: p.chipNumber ?? '',
	vet: p.vet,
	memberIds: p.memberIds,
	notes: p.notes ?? '',
});

export const toValues = (v: PetFormValue): PetValues => ({
	name: v.name.trim(),
	species: v.species,
	breed: v.breed.trim(),
	sex: v.sex || null,
	birthDate: v.birthDate || null,
	chipNumber: v.chipNumber.trim() || null,
	vet: v.vet.trim(),
	memberIds: v.memberIds,
	notes: v.notes.trim() || null,
});

export function validate(v: PetFormValue): FieldErrors {
	const errors: FieldErrors = {};
	if (!v.name.trim()) errors.name = FIELD_REASON.name;
	return errors;
}

export const species = SPECIES;
export const sexes = SEXES;

/** A preset ticked in the add form, with its first due date. */
export type PresetPicks = Record<PresetId, PresetPickState>;
export const freshPicks = (): PresetPicks =>
	Object.fromEntries(PET_PRESETS.map((p) => [p.id, freshPick(p)])) as PresetPicks;
