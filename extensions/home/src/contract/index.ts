import { type ObligationPreset, PresetScheduleSchema } from '@famos/ext-records/contract';
import { idSchema, wholeRecord } from '@famos/sdk';
import { IsoDateSchema } from '@famos/time';
import { z } from 'zod';

/**
 * Home contract: the places the family lives in or looks after, the things in them (with a
 * warranty), the services they pay for (electricity, internet, dues…) and the people who fix
 * things. Homes, things and services are records for `records`: what comes back
 * (insurance, heating service, a warranty ending) and the papers live there, known by id. Dates
 * only, and no money fields.
 */
export const HomeIdSchema = idSchema('home');
export const ItemIdSchema = idSchema('home_item');
export const ServiceIdSchema = idSchema('home_service');

export const TENURES = ['owner', 'tenant', 'other'] as const;
export const TenureSchema = z.enum(TENURES);
export type Tenure = z.infer<typeof TenureSchema>;

export const SERVICE_KINDS = [
	'electricity',
	'gas',
	'water',
	'internet',
	'phone',
	'tv',
	'insurance',
	'dues',
	'other',
] as const;
export const ServiceKindSchema = z.enum(SERVICE_KINDS);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

/** Kinds of record in `records`, which are also the prefixes of the ids and the AI handles. */
export const HOME_KIND = 'home';
export const ITEM_KIND = 'home_item';
export const SERVICE_KIND = 'home_service';

/** Paths of the pages that `records` links to from lists that span records. */
export const homeUrl = (id: string) => `/home/${id}`;
export const itemUrl = (id: string) => `/home/items/${id}`;
export const serviceUrl = (id: string) => `/home/services/${id}`;

/** The capability whose holders are reminded about a home's obligations when nobody is assigned. */
export const HOME_AUDIENCE = 'home.view';

/** Kind and lead time of the obligation that a thing's warranty end creates by itself. */
export const WARRANTY_KIND = 'warranty_end';
export const WARRANTY_LEAD_DAYS = 30;

/**
 * "What usually needs doing" for a home. Every one is a date and a repeat. They only suggest an
 * interval and lead time: the person sets both when picking one. Titles are keys of
 * this extension's catalog.
 */
export const HOME_PRESETS = [
	{
		id: 'home_insurance',
		titleKey: 'home:preset_home_insurance',
		every: { years: 1 },
		leadDays: 30,
		labelKey: 'home:preset_home_insurance_hint',
	},
	{
		id: 'heating_service',
		titleKey: 'home:preset_heating_service',
		every: { years: 1 },
		leadDays: 21,
		labelKey: 'home:preset_heating_service_hint',
	},
	{
		id: 'alarm_check',
		titleKey: 'home:preset_alarm_check',
		every: { years: 1 },
		leadDays: 14,
		labelKey: 'home:preset_alarm_check_hint',
	},
	{
		id: 'lease_review',
		titleKey: 'home:preset_lease_review',
		every: { years: 1 },
		leadDays: 30,
		labelKey: 'home:preset_lease_review_hint',
	},
] as const satisfies readonly ObligationPreset[];
export type HomePresetId = (typeof HOME_PRESETS)[number]['id'];
export const HOME_PRESET_IDS = HOME_PRESETS.map((p) => p.id) as [HomePresetId, ...HomePresetId[]];

/** The same for a thing in the home. */
export const ITEM_PRESETS = [
	{
		id: 'filter_change',
		titleKey: 'home:preset_filter_change',
		every: { months: 6 },
		leadDays: 14,
		labelKey: 'home:preset_filter_change_hint',
	},
	{
		id: 'service',
		titleKey: 'home:preset_service',
		every: { years: 1 },
		leadDays: 21,
		labelKey: 'home:preset_service_hint',
	},
] as const satisfies readonly ObligationPreset[];
export type ItemPresetId = (typeof ITEM_PRESETS)[number]['id'];
export const ITEM_PRESET_IDS = ITEM_PRESETS.map((p) => p.id) as [ItemPresetId, ...ItemPresetId[]];

/** A duty picked from a preset list when the record is added; the first due date is the person's. */
const pick = <T extends [string, ...string[]]>(ids: T) =>
	PresetScheduleSchema.extend({
		preset: z.enum(ids),
		/** The translated title the person saw; stored on the obligation. */
		title: z.string().trim().min(1).max(160),
		dueDate: IsoDateSchema,
	});
export const HomePresetPickSchema = pick(HOME_PRESET_IDS);
export const ItemPresetPickSchema = pick(ITEM_PRESET_IDS);

const text = (max: number) => z.string().trim().max(max).default('');

/* Homes */

export const HomeFieldsSchema = z.object({
	name: z.string().trim().min(1).max(80).describe('What the family calls it, e.g. "Our flat"'),
	address: text(300),
	tenure: TenureSchema.default('owner'),
	notes: z.string().trim().max(2000).nullable().optional(),
});
export type HomeFields = z.input<typeof HomeFieldsSchema>;

export const AddHomeSchema = HomeFieldsSchema.extend({
	obligations: z.array(HomePresetPickSchema).max(HOME_PRESET_IDS.length).default([]),
});
export type AddHomeInput = z.input<typeof AddHomeSchema>;
/** The whole home as the form saves it: every field, null for one left empty. */
export const UpdateHomeSchema = z.object({ id: HomeIdSchema, home: wholeRecord(HomeFieldsSchema) });
export type HomeReplace = z.input<typeof UpdateHomeSchema>['home'];

export const HomeSchema = z.object({
	id: z.string(),
	name: z.string(),
	address: z.string(),
	tenure: TenureSchema,
	notes: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Home = z.infer<typeof HomeSchema>;

/* Things */

export const ItemFieldsSchema = z.object({
	name: z.string().trim().min(1).max(80).describe('What it is, e.g. "Washing machine"'),
	room: text(60).describe('Where it is, e.g. "Kitchen"'),
	brand: text(60),
	model: text(60),
	serial: z.string().trim().max(60).nullable().optional(),
	purchasedOn: IsoDateSchema.nullable().optional().describe('The day it was bought, YYYY-MM-DD'),
	warrantyUntil: IsoDateSchema.nullable()
		.optional()
		.describe('The last day of the warranty, YYYY-MM-DD'),
	notes: z.string().trim().max(2000).nullable().optional(),
});
export type ItemFields = z.input<typeof ItemFieldsSchema>;

export const AddItemSchema = ItemFieldsSchema.extend({
	homeId: HomeIdSchema.describe('The home it is in'),
	obligations: z.array(ItemPresetPickSchema).max(ITEM_PRESET_IDS.length).default([]),
	/** Only for people reviewing a suggestion: which home it is. Never stored. */
	homeName: z
		.string()
		.trim()
		.max(120)
		.optional()
		.describe('The home as listed, e.g. "Our flat"; only shown to the reviewer'),
});
export type AddItemInput = z.input<typeof AddItemSchema>;

/**
 * Only what is given changes (a field set to `null` is cleared; one left out is kept), so a
 * suggestion such as "warranty extended" touches nothing else; the form sends every field.
 */
export const UpdateItemSchema = z.object({
	id: ItemIdSchema.describe('The thing'),
	// Plain optionals, not the fields' defaults: a field left out must stay as it is.
	name: z.string().trim().min(1).max(80).optional(),
	room: z.string().trim().max(60).optional(),
	brand: z.string().trim().max(60).optional(),
	model: z.string().trim().max(60).optional(),
	serial: ItemFieldsSchema.shape.serial,
	purchasedOn: ItemFieldsSchema.shape.purchasedOn,
	warrantyUntil: ItemFieldsSchema.shape.warrantyUntil,
	notes: ItemFieldsSchema.shape.notes,
	/** Only for people reviewing a suggestion: which thing it is. Never stored. */
	itemName: z
		.string()
		.trim()
		.max(120)
		.optional()
		.describe('The thing as listed, e.g. "Washing machine"; only shown to the reviewer'),
});
export type UpdateItemInput = z.input<typeof UpdateItemSchema>;

export const ItemSchema = z.object({
	id: z.string(),
	homeId: z.string(),
	name: z.string(),
	room: z.string(),
	brand: z.string(),
	model: z.string(),
	serial: z.string().nullable(),
	purchasedOn: z.string().nullable(),
	warrantyUntil: z.string().nullable(),
	notes: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Item = z.infer<typeof ItemSchema>;

/* Services */

export const ServiceFieldsSchema = z.object({
	kind: ServiceKindSchema.default('other'),
	provider: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.describe('The company, e.g. "the electricity company"'),
	accountNumber: z.string().trim().max(60).nullable().optional(),
	dueDay: z
		.number()
		.int()
		.min(1)
		.max(31)
		.nullable()
		.optional()
		.describe('The usual billing day of the month; informational'),
	notes: z.string().trim().max(2000).nullable().optional(),
});
export type ServiceFields = z.input<typeof ServiceFieldsSchema>;

export const AddServiceSchema = ServiceFieldsSchema.extend({ homeId: HomeIdSchema });
export type AddServiceInput = z.input<typeof AddServiceSchema>;
/** The whole service as the form saves it: every field, null for one left empty. */
export const UpdateServiceSchema = z.object({
	id: ServiceIdSchema,
	service: wholeRecord(ServiceFieldsSchema),
});
export type ServiceReplace = z.input<typeof UpdateServiceSchema>['service'];

export const ServiceSchema = z.object({
	id: z.string(),
	homeId: z.string(),
	kind: ServiceKindSchema,
	provider: z.string(),
	accountNumber: z.string().nullable(),
	dueDay: z.number().int().nullable(),
	notes: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const homeChangedPayload = z.object({ homeId: z.string().nullable() });
