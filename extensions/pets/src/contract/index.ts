import { type ObligationPreset, PresetScheduleSchema } from '@famos/ext-records/contract';
import { idSchema } from '@famos/sdk';
import { IsoDateSchema } from '@famos/time';
import { z } from 'zod';

/**
 * Pets contract: the household's animals with a treatment history. What comes back (vaccines,
 * parasite treatment, check-ups) and the papers live in `records`; a pet is known
 * there by its id. Dates only, no costs. A pet photo is
 * not kept yet.
 */
export const PetIdSchema = idSchema('pet');
export const PetTreatmentIdSchema = idSchema('pet_treatment');
export const MemberIdSchema = idSchema('member');
export const RecordDocIdSchema = idSchema('record_doc');
export const ObligationIdSchema = idSchema('obligation');

export const SPECIES = ['dog', 'cat', 'bird', 'rabbit', 'fish', 'reptile', 'other'] as const;
export const SpeciesSchema = z.enum(SPECIES);
export type Species = z.infer<typeof SpeciesSchema>;

export const SEXES = ['female', 'male'] as const;
export const SexSchema = z.enum(SEXES);
export type Sex = z.infer<typeof SexSchema>;

export const TREATMENT_KINDS = [
	'vaccination',
	'parasite_internal',
	'parasite_external',
	'checkup',
	'medication',
	'other',
] as const;
export const TreatmentKindSchema = z.enum(TREATMENT_KINDS);
export type TreatmentKind = z.infer<typeof TreatmentKindSchema>;

/** The kind of record in `records` and the prefix of a pet's id. */
export const RECORD_KIND = 'pet';
/** Path of a pet's page, which `records` links to from lists that span records. */
export const petUrl = (id: string) => `/pets/${id}`;

/**
 * "What usually needs doing" for a pet, offered when it is added and later on its page. The
 * wording is generic; `species` says which animals it is suggested for. Every one is a date and
 * a repeat. They only suggest an interval and lead time: the vet and the country decide, so the
 * person sets both. Titles are keys of this extension's catalog.
 */
export const PET_PRESETS = [
	{
		id: 'rabies',
		titleKey: 'pets:preset_rabies',
		every: { years: 1 },
		leadDays: 30,
		labelKey: 'pets:preset_rabies_hint',
		species: ['dog', 'cat', 'rabbit', 'other'],
	},
	{
		id: 'core_vaccine',
		titleKey: 'pets:preset_core_vaccine',
		every: { years: 1 },
		leadDays: 30,
		labelKey: 'pets:preset_core_vaccine_hint',
		species: ['dog', 'cat', 'rabbit', 'other'],
	},
	{
		id: 'parasite_internal',
		titleKey: 'pets:preset_parasite_internal',
		every: { months: 3 },
		leadDays: 7,
		labelKey: 'pets:preset_parasite_internal_hint',
		species: ['dog', 'cat', 'rabbit', 'bird', 'reptile', 'other'],
	},
	{
		id: 'parasite_external',
		titleKey: 'pets:preset_parasite_external',
		every: { months: 1 },
		leadDays: 3,
		labelKey: 'pets:preset_parasite_external_hint',
		species: ['dog', 'cat', 'rabbit', 'other'],
	},
	{
		id: 'checkup',
		titleKey: 'pets:preset_checkup',
		every: { years: 1 },
		leadDays: 21,
		labelKey: 'pets:preset_checkup_hint',
		species: ['dog', 'cat', 'bird', 'rabbit', 'fish', 'reptile', 'other'],
	},
] as const satisfies readonly (ObligationPreset & { species: readonly Species[] })[];
export type PresetId = (typeof PET_PRESETS)[number]['id'];
export const PRESET_IDS = PET_PRESETS.map((p) => p.id) as [PresetId, ...PresetId[]];

/** The presets suggested for a species. */
export const presetsFor = (species: Species) =>
	PET_PRESETS.filter((p) => (p.species as readonly Species[]).includes(species));

/** The capability whose holders are reminded about a pet's obligations when nobody is assigned. */
export const PET_AUDIENCE = 'pets.view';

export const PetFieldsSchema = z.object({
	name: z.string().trim().min(1).max(80).describe('What the family calls it, e.g. "Luna"'),
	species: SpeciesSchema.default('other'),
	breed: z.string().trim().max(80).default(''),
	sex: SexSchema.nullable().optional(),
	birthDate: IsoDateSchema.nullable().optional(),
	chipNumber: z.string().trim().max(40).nullable().optional(),
	vet: z.string().trim().max(300).default('').describe('Clinic and phone, free text'),
	memberIds: z.array(MemberIdSchema).max(20).default([]).describe('Who looks after it'),
	notes: z.string().trim().max(2000).nullable().optional(),
});
export type PetFields = z.input<typeof PetFieldsSchema>;

/** A duty picked from the presets when the pet is added; the first due date is the person's. */
export const PresetPickSchema = PresetScheduleSchema.extend({
	preset: z.enum(PRESET_IDS),
	/** The translated title the person saw; stored on the obligation. */
	title: z.string().trim().min(1).max(160),
	dueDate: IsoDateSchema,
});

export const AddPetSchema = PetFieldsSchema.extend({
	obligations: z.array(PresetPickSchema).max(PRESET_IDS.length).default([]),
});
export type AddPetInput = z.input<typeof AddPetSchema>;

export const UpdatePetSchema = z.object({ id: PetIdSchema, pet: PetFieldsSchema });

export const PetSchema = z.object({
	id: z.string(),
	name: z.string(),
	species: SpeciesSchema,
	breed: z.string(),
	sex: SexSchema.nullable(),
	birthDate: z.string().nullable(),
	chipNumber: z.string().nullable(),
	vet: z.string(),
	memberIds: z.array(z.string()),
	notes: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Pet = z.infer<typeof PetSchema>;

export const AddTreatmentSchema = z.object({
	petId: PetIdSchema.describe('The pet'),
	kind: TreatmentKindSchema.default('vaccination'),
	givenOn: IsoDateSchema.describe('The day it was given, YYYY-MM-DD'),
	product: z
		.string()
		.trim()
		.max(160)
		.default('')
		.describe('What was given, e.g. "Nobivac Rabies" or "Drontal"'),
	batch: z.string().trim().max(60).nullable().optional().describe('Batch or lot number'),
	vet: z.string().trim().max(160).nullable().optional().describe('Clinic or vet'),
	notes: z.string().trim().max(2000).nullable().optional(),
	documentId: RecordDocIdSchema.nullable().optional(),
	/**
	 * An open duty of this pet that the treatment fulfils: it is marked done on the same day and
	 * moves on to its next date. Without it only the history entry is added.
	 */
	obligationId: ObligationIdSchema.nullable()
		.optional()
		.describe('The open duty this fulfils (its handle, e.g. obligation:2), if one matches'),
	nextDueDate: IsoDateSchema.optional().describe(
		'When the next one is due, YYYY-MM-DD, when known; only with obligationId',
	),
	/** Only for people reviewing a suggestion: which pet it is. Never stored. */
	petName: z
		.string()
		.trim()
		.max(120)
		.optional()
		.describe('The pet as listed, e.g. "Luna"; only shown to the reviewer'),
});
export type AddTreatmentInput = z.input<typeof AddTreatmentSchema>;

export const PetTreatmentSchema = z.object({
	id: z.string(),
	petId: z.string(),
	kind: TreatmentKindSchema,
	givenOn: z.string(),
	product: z.string(),
	batch: z.string().nullable(),
	vet: z.string().nullable(),
	notes: z.string().nullable(),
	documentId: z.string().nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.number(),
});
export type PetTreatment = z.infer<typeof PetTreatmentSchema>;

export const petChangedPayload = z.object({ petId: z.string() });
