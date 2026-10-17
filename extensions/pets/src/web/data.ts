import { unwrap } from '@famos/api-client';
import type { Obligation, RecordDocument } from '@famos/ext-records/contract';
import type {
	AddPetInput,
	AddTreatmentInput,
	Pet,
	PetReplace,
	PetTreatment,
} from '../contract/index.js';
import { api } from './api.js';

/** Pets API calls, all through the generated client. */
export type Outcome = 'applied' | 'drafted';

export const loadPets = async (): Promise<Pet[]> => unwrap(await api.GET('/api/v1/pets/pets'));

export const loadPet = async (petId: string): Promise<Pet> =>
	unwrap(await api.GET('/api/v1/pets/pets/{petId}', { params: { path: { petId } } }));

export const loadTreatments = async (petId: string): Promise<PetTreatment[]> =>
	unwrap(await api.GET('/api/v1/pets/pets/{petId}/treatments', { params: { path: { petId } } }));

/** The papers filed to a pet (records), to link one to a treatment. */
export const loadPapers = async (recordId: string): Promise<RecordDocument[]> =>
	unwrap(await api.GET('/api/v1/records/documents', { params: { query: { recordId } } }));

/** The pet's open duties (records), to say which one a treatment fulfils. */
export const loadDuties = async (recordId: string): Promise<Obligation[]> =>
	unwrap(
		await api.GET('/api/v1/records/obligations', {
			params: { query: { recordId, status: 'open' } },
		}),
	);

/** What the form saves: the whole pet, null for a field left empty. */
export type PetValues = PetReplace;

export async function addPet(input: AddPetInput): Promise<{ outcome: Outcome; id: string | null }> {
	const result = unwrap(await api.POST('/api/v1/actions/pets.addPet', { body: input }));
	return { outcome: result.status, id: result.status === 'applied' ? result.output.id : null };
}

export async function updatePet(id: string, pet: PetValues): Promise<Outcome> {
	return unwrap(await api.POST('/api/v1/actions/pets.updatePet', { body: { id, pet } })).status;
}

export const archivePet = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/pets.archivePet', { body: { id } })).status;

export const addTreatment = async (input: AddTreatmentInput): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/pets.addTreatment', { body: input })).status;

export const removeTreatment = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/pets.removeTreatment', { body: { id } })).status;
