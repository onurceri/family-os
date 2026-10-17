import { type AddObligationInput, type Obligation, scheduleOf } from '@famos/ext-records/contract';
import {
	type Actor,
	AiContextSchema,
	defineAction,
	defineEvent,
	defineRoute,
	FamosError,
	storedAsWhole,
	type UnitOfWork,
} from '@famos/sdk';
import { z } from 'zod';
import {
	AddPetSchema,
	AddTreatmentSchema,
	PET_AUDIENCE,
	PET_PRESETS,
	PetFieldsSchema,
	PetIdSchema,
	PetSchema,
	PetTreatmentIdSchema,
	PetTreatmentSchema,
	petChangedPayload,
	petUrl,
	RECORD_KIND,
	UpdatePetSchema,
} from '../contract/index.ts';
import { petsEdit, petsView } from './capabilities.ts';
import { type PetRow, tables, toPet, toTreatment } from './store.ts';

export const petChanged = defineEvent('pets.pet.changed', petChangedPayload);

const memberId = (actor: Actor) => (actor.kind === 'member' ? actor.memberId : null);

async function assertMembers(uow: UnitOfWork, ids: readonly string[]) {
	if (ids.length === 0) return;
	const active = new Set((await uow.family.members()).map((m) => m.id));
	const unknown = ids.find((id) => !active.has(id));
	if (unknown) throw new FamosError('bad_request', `Unknown member: ${unknown}`);
}

async function load(uow: UnitOfWork, id: string): Promise<PetRow> {
	const row = await tables(uow.db)
		.selectFrom('pets_pets')
		.selectAll()
		.where('id', '=', id)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Pet not found');
	return row;
}

const fieldsOf = (p: z.output<typeof PetFieldsSchema>) => ({
	name: p.name,
	species: p.species,
	breed: p.breed,
	sex: p.sex ?? null,
	birth_date: p.birthDate ?? null,
	chip_number: p.chipNumber || null,
	vet: p.vet,
	member_ids: JSON.stringify([...new Set(p.memberIds)]),
	notes: p.notes || null,
});

export const addPet = defineAction({
	id: 'pets.addPet',
	title: 'Add a pet',
	draftTitle: 'pets:draft_title_add_pet',
	input: AddPetSchema,
	output: PetSchema,
	approval: { unless: petsEdit.id },
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('pets_pets')
			.select('id')
			.where('archived_at', 'is', null)
			.where('name', '=', input.name)
			.where('species', '=', input.species)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, { obligations, ...input }) {
		await assertMembers(uow, input.memberIds);
		const now = uow.clock.now();
		const row: PetRow = {
			id: uow.ids.next('pet'),
			...fieldsOf(input),
			created_by: memberId(uow.actor),
			created_at: now,
			updated_at: now,
			archived_at: null,
		};
		await tables(uow.db).insertInto('pets_pets').values(row).execute();
		// What usually needs doing, as picked: the repeat and lead time are the person's, the preset only suggests them.
		for (const pick of obligations) {
			const preset = PET_PRESETS.find((p) => p.id === pick.preset);
			if (!preset) throw new FamosError('bad_request', `Unknown preset: ${pick.preset}`);
			const obligation: AddObligationInput = {
				recordId: row.id,
				recordKind: RECORD_KIND,
				recordName: row.name,
				recordUrl: petUrl(row.id),
				kind: preset.id,
				title: pick.title,
				dueDate: pick.dueDate,
				...scheduleOf(preset, pick),
				audience: PET_AUDIENCE,
			};
			await uow.run('records.addObligation', obligation);
		}
		uow.emit(petChanged, { petId: row.id });
		return toPet(row);
	},
});

export const updatePet = defineAction({
	id: 'pets.updatePet',
	title: 'Change a pet',
	draftTitle: 'pets:draft_title_update_pet',
	input: UpdatePetSchema,
	// Waiting from when a field left out meant empty (or its default): read that way.
	storedInput: storedAsWhole(PetFieldsSchema, 'pet'),
	output: PetSchema,
	approval: { unless: petsEdit.id },
	async run(uow, { id, pet }) {
		const row = await load(uow, id);
		await assertMembers(uow, pet.memberIds);
		const patch = { ...fieldsOf(pet), updated_at: uow.clock.now() };
		await tables(uow.db).updateTable('pets_pets').set(patch).where('id', '=', id).execute();
		// Lists that span records ("Coming up", reminders) show the name.
		if (patch.name !== row.name) {
			await uow.run('records.renameRecord', { recordId: id, name: patch.name, url: petUrl(id) });
		}
		uow.emit(petChanged, { petId: id });
		return toPet({ ...row, ...patch });
	},
});

/** Hides the pet and its obligations and papers (kept, no more reminders). */
export const archivePet = defineAction({
	id: 'pets.archivePet',
	title: 'Archive a pet',
	draftTitle: 'pets:draft_title_archive_pet',
	input: z.object({ id: PetIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: petsEdit.id },
	async run(uow, { id }) {
		await load(uow, id);
		const now = uow.clock.now();
		await tables(uow.db)
			.updateTable('pets_pets')
			.set({ archived_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		await uow.run('records.archiveForRecord', { recordId: id });
		uow.emit(petChanged, { petId: id });
		return { ok: true as const };
	},
});

export const addTreatment = defineAction({
	id: 'pets.addTreatment',
	title: 'Add a treatment',
	draftTitle: 'pets:draft_title_add_treatment',
	description:
		'Adds a history entry. With an open duty of the same pet it also marks that duty done on the same day, so its next date moves on.',
	input: AddTreatmentSchema,
	output: PetTreatmentSchema,
	approval: { unless: petsEdit.id },
	// The pet by its name on record: a form sends only its id.
	async subject(ctx, { petId }) {
		const row = await tables(ctx.db)
			.selectFrom('pets_pets')
			.select('name')
			.where('id', '=', petId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		return row?.name ?? null;
	},
	undo: (treatment) => ({ actionId: 'pets.removeTreatment', input: { id: treatment.id } }),
	ai: {
		description:
			'Record a treatment given to a household pet from a vet card, a vet receipt or a message: a vaccination, a parasite treatment, a check-up or a medication, with the date and the product. The pet must be one of the household pets.',
		guidance:
			'petId is the pet’s reference from the pets list; look the pet up first, and when it is not there, say so instead. givenOn is the day it was given. kind is vaccination, parasite_internal, parasite_external, checkup, medication or other. product is what was given, batch the lot number, vet the clinic. When an open duty of that pet matches (for example the rabies vaccination), give its reference from the list of duties as obligationId and, when the next one’s date is known, nextDueDate; otherwise leave both out. Do not put amounts of money anywhere. petName is the pet as listed.',
	},
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('pets_treatments')
			.select('id')
			.where('pet_id', '=', input.petId)
			.where('given_on', '=', input.givenOn)
			.where('kind', '=', input.kind)
			.where('product', '=', input.product)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, input) {
		await load(uow, input.petId);
		const row = {
			id: uow.ids.next('pet_treatment'),
			pet_id: input.petId,
			kind: input.kind,
			given_on: input.givenOn,
			product: input.product,
			batch: input.batch || null,
			vet: input.vet || null,
			notes: input.notes || null,
			document_id: input.documentId ?? null,
			created_by: memberId(uow.actor),
			created_at: uow.clock.now(),
		};
		await tables(uow.db).insertInto('pets_treatments').values(row).execute();
		if (input.obligationId) {
			// In the same transaction: a duty that is not this pet's rolls the whole thing back.
			const done = await uow.run<unknown, Obligation>('records.completeObligation', {
				id: input.obligationId,
				doneOn: input.givenOn,
				...(input.nextDueDate && { nextDueDate: input.nextDueDate }),
			});
			if (done.recordId !== input.petId)
				throw new FamosError('bad_request', 'That duty belongs to another record');
		}
		uow.emit(petChanged, { petId: input.petId });
		return toTreatment(row);
	},
});

export const removeTreatment = defineAction({
	id: 'pets.removeTreatment',
	title: 'Remove a treatment',
	draftTitle: 'pets:draft_title_remove_treatment',
	input: z.object({ id: PetTreatmentIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: petsEdit.id },
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('pets_treatments')
			.select('pet_id')
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Treatment not found');
		await tables(uow.db).deleteFrom('pets_treatments').where('id', '=', id).execute();
		uow.emit(petChanged, { petId: row.pet_id });
		return { ok: true as const };
	},
});

const MAX_CONTEXT = 50;

/**
 * What the AI may know about the household's pets, so a vet card or receipt can name the right
 * one. Read by the Inbox as the AI actor; a locked area refuses it. No chip number, no notes.
 */
export const aiContext = defineAction({
	id: 'pets.aiContext',
	title: 'Pets, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: petsView.id,
	ai: {
		description:
			'Lists the household pets: name, species and breed. Use it to find which pet a question is about.',
	},
	async run(uow) {
		const rows = await tables(uow.db)
			.selectFrom('pets_pets')
			.selectAll()
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.limit(MAX_CONTEXT)
			.execute();
		return {
			kind: RECORD_KIND,
			label: 'Pets',
			items: rows.map((r) => {
				const details = [r.species, r.breed].filter(Boolean).join(', ');
				return { id: r.id, label: r.name, ...(details && { details }), url: petUrl(r.id) };
			}),
		};
	},
});

export const listPets = defineRoute({
	method: 'get',
	path: '/pets',
	operationId: 'pets.listPets',
	summary: 'The household’s pets',
	requires: petsView.id,
	response: z.array(PetSchema),
	async handle(ctx) {
		const rows = await tables(ctx.db)
			.selectFrom('pets_pets')
			.selectAll()
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.orderBy('id')
			.execute();
		return rows.map(toPet);
	},
});

export const getPet = defineRoute({
	method: 'get',
	path: '/pets/{petId}',
	operationId: 'pets.getPet',
	summary: 'One pet',
	requires: petsView.id,
	params: z.object({ petId: PetIdSchema }),
	response: PetSchema,
	async handle(ctx, { params }) {
		const row = await tables(ctx.db)
			.selectFrom('pets_pets')
			.selectAll()
			.where('id', '=', params.petId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Pet not found');
		return toPet(row);
	},
});

export const listTreatments = defineRoute({
	method: 'get',
	path: '/pets/{petId}/treatments',
	operationId: 'pets.listTreatments',
	summary: 'The treatment history of a pet, newest first',
	requires: petsView.id,
	params: z.object({ petId: PetIdSchema }),
	response: z.array(PetTreatmentSchema),
	async handle(ctx, { params }) {
		const rows = await tables(ctx.db)
			.selectFrom('pets_treatments')
			.selectAll()
			.where('pet_id', '=', params.petId)
			.orderBy('given_on', 'desc')
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.execute();
		return rows.map(toTreatment);
	},
});
