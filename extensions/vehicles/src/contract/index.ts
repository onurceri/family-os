import { type ObligationPreset, PresetScheduleSchema } from '@famos/ext-records/contract';
import { idSchema } from '@famos/sdk';
import { IsoDateSchema } from '@famos/time';
import { z } from 'zod';

/**
 * Vehicles contract: the cars, motorbikes and so on of the household, with a service and repair
 * log. What comes back (insurance, inspection, tax…) and the papers live in `records`;
 * a vehicle is known there by its id. Dates only, no odometer or units: a mileage, if the family
 * wants to keep one, goes in the notes of a log entry.
 */
export const VehicleIdSchema = idSchema('vehicle');
export const VehicleLogIdSchema = idSchema('vehicle_log');
export const MemberIdSchema = idSchema('member');
export const RecordDocIdSchema = idSchema('record_doc');

export const FUELS = ['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'other'] as const;
export const FuelSchema = z.enum(FUELS);
export type Fuel = z.infer<typeof FuelSchema>;

export const LOG_KINDS = ['service', 'repair', 'other'] as const;
export const LogKindSchema = z.enum(LOG_KINDS);
export type LogKind = z.infer<typeof LogKindSchema>;

/** The kind of record in `records` and the prefix of a vehicle's id. */
export const RECORD_KIND = 'vehicle';
/** Path of a vehicle's page, which `records` links to from lists that span records. */
export const vehicleUrl = (id: string) => `/vehicles/${id}`;

/**
 * "What usually needs doing" for a vehicle, offered when it is added and later on its page. Every
 * one is a date and a repeat, so no odometer is needed. They only suggest an interval and lead
 * time: rules and habits differ by country, so the person sets both. Titles are keys of
 * this extension's catalog.
 */
export const VEHICLE_PRESETS = [
	{
		id: 'liability_insurance',
		titleKey: 'vehicles:preset_liability_insurance',
		every: { years: 1 },
		leadDays: 30,
		labelKey: 'vehicles:preset_liability_insurance_hint',
	},
	{
		id: 'comprehensive_insurance',
		titleKey: 'vehicles:preset_comprehensive_insurance',
		every: { years: 1 },
		leadDays: 30,
		labelKey: 'vehicles:preset_comprehensive_insurance_hint',
	},
	{
		id: 'inspection',
		titleKey: 'vehicles:preset_inspection',
		every: { years: 1 },
		leadDays: 30,
		labelKey: 'vehicles:preset_inspection_hint',
	},
	{
		id: 'service',
		titleKey: 'vehicles:preset_service',
		every: { years: 1 },
		leadDays: 21,
		labelKey: 'vehicles:preset_service_hint',
	},
	{
		id: 'tyres',
		titleKey: 'vehicles:preset_tyres',
		every: { months: 6 },
		leadDays: 14,
		labelKey: 'vehicles:preset_tyres_hint',
	},
	{
		id: 'vehicle_tax',
		titleKey: 'vehicles:preset_vehicle_tax',
		every: { years: 1 },
		leadDays: 14,
		labelKey: 'vehicles:preset_vehicle_tax_hint',
	},
] as const satisfies readonly ObligationPreset[];
export type PresetId = (typeof VEHICLE_PRESETS)[number]['id'];
export const PRESET_IDS = VEHICLE_PRESETS.map((p) => p.id) as [PresetId, ...PresetId[]];

/** The capability whose holders are reminded about a vehicle's obligations when nobody is assigned. */
export const VEHICLE_AUDIENCE = 'vehicles.view';

export const VehicleFieldsSchema = z.object({
	name: z.string().trim().min(1).max(80).describe('What the family calls it, e.g. "Family car"'),
	plate: z.string().trim().max(20).default(''),
	make: z.string().trim().max(60).default(''),
	model: z.string().trim().max(60).default(''),
	year: z.number().int().min(1900).max(2100).nullable().optional(),
	fuel: FuelSchema.default('other'),
	vin: z.string().trim().max(40).nullable().optional(),
	memberIds: z.array(MemberIdSchema).max(20).default([]).describe('Who drives or owns it'),
	notes: z.string().trim().max(2000).nullable().optional(),
});
export type VehicleFields = z.input<typeof VehicleFieldsSchema>;

/** A duty picked from the presets when the vehicle is added; the first due date is the person's. */
export const PresetPickSchema = PresetScheduleSchema.extend({
	preset: z.enum(PRESET_IDS),
	/** The translated title the person saw; stored on the obligation. */
	title: z.string().trim().min(1).max(160),
	dueDate: IsoDateSchema,
});

export const AddVehicleSchema = VehicleFieldsSchema.extend({
	obligations: z.array(PresetPickSchema).max(PRESET_IDS.length).default([]),
});
export type AddVehicleInput = z.input<typeof AddVehicleSchema>;

export const UpdateVehicleSchema = z.object({ id: VehicleIdSchema, vehicle: VehicleFieldsSchema });

export const VehicleSchema = z.object({
	id: z.string(),
	name: z.string(),
	plate: z.string(),
	make: z.string(),
	model: z.string(),
	year: z.number().int().nullable(),
	fuel: FuelSchema,
	vin: z.string().nullable(),
	memberIds: z.array(z.string()),
	notes: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Vehicle = z.infer<typeof VehicleSchema>;

export const AddLogSchema = z.object({
	vehicleId: VehicleIdSchema.describe('The vehicle'),
	kind: LogKindSchema.default('service'),
	doneOn: IsoDateSchema.describe('The day it was done, YYYY-MM-DD'),
	place: z.string().trim().max(160).nullable().optional().describe('Garage or workshop'),
	notes: z
		.string()
		.trim()
		.max(2000)
		.nullable()
		.optional()
		.describe('What was done; a mileage may be written here'),
	documentId: RecordDocIdSchema.nullable().optional(),
	/** Only for people reviewing a suggestion: which vehicle it is. Never stored. */
	vehicleName: z
		.string()
		.trim()
		.max(120)
		.optional()
		.describe('The vehicle as listed, e.g. "Family car"; only shown to the reviewer'),
});
export type AddLogInput = z.input<typeof AddLogSchema>;

export const VehicleLogSchema = z.object({
	id: z.string(),
	vehicleId: z.string(),
	kind: LogKindSchema,
	doneOn: z.string(),
	place: z.string().nullable(),
	notes: z.string().nullable(),
	documentId: z.string().nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.number(),
});
export type VehicleLog = z.infer<typeof VehicleLogSchema>;

export const vehicleChangedPayload = z.object({ vehicleId: z.string() });
