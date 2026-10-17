import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { petsEdit, petsView } from './capabilities.ts';
import {
	addPet,
	addTreatment,
	aiContext,
	archivePet,
	getPet,
	listPets,
	listTreatments,
	petChanged,
	removeTreatment,
	updatePet,
} from './pets.ts';
import { migrations } from './store.ts';
import { treatmentKind } from './understand.ts';

/**
 * Pets: the household's animals with a treatment history. Their duties (vaccines, parasite
 * treatment, check-ups) and papers are kept by `records`, reached only through its actions.
 * The AI learns which pets exist through `pets.aiContext`.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { context: aiContext.id, kinds: [treatmentKind] },
	actions: [addPet, updatePet, archivePet, addTreatment, removeTreatment, aiContext],
	routes: [listPets, getPet, listTreatments],
	events: [petChanged],
	capabilities: [petsView, petsEdit],
});
