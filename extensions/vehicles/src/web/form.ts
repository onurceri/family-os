import { freshPick, type PresetPickState } from '@famos/ext-records/contract';
import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import {
	FUELS,
	type Fuel,
	type PresetId,
	VEHICLE_PRESETS,
	type Vehicle,
} from '../contract/index.js';
import type { VehicleValues } from './data.js';

/** The vehicle form as the inputs hold it. */
export interface VehicleFormValue {
	name: string;
	plate: string;
	make: string;
	model: string;
	year: string;
	fuel: Fuel;
	vin: string;
	memberIds: string[];
	notes: string;
}

export const emptyVehicle = (): VehicleFormValue => ({
	name: '',
	plate: '',
	make: '',
	model: '',
	year: '',
	fuel: 'petrol',
	vin: '',
	memberIds: [],
	notes: '',
});

export const fromVehicle = (v: Vehicle): VehicleFormValue => ({
	name: v.name,
	plate: v.plate,
	make: v.make,
	model: v.model,
	year: v.year === null ? '' : String(v.year),
	fuel: v.fuel,
	vin: v.vin ?? '',
	memberIds: v.memberIds,
	notes: v.notes ?? '',
});

export function toValues(v: VehicleFormValue): VehicleValues {
	const year = Number.parseInt(v.year, 10);
	return {
		name: v.name.trim(),
		plate: v.plate.trim(),
		make: v.make.trim(),
		model: v.model.trim(),
		year: Number.isFinite(year) ? year : null,
		fuel: v.fuel,
		vin: v.vin.trim() || null,
		memberIds: v.memberIds,
		notes: v.notes.trim() || null,
	};
}

export function validate(v: VehicleFormValue): FieldErrors {
	const errors: FieldErrors = {};
	if (!v.name.trim()) errors.name = FIELD_REASON.name;
	if (v.year.trim() && !/^\d{4}$/.test(v.year.trim())) errors.year = 'vehicles:error_year';
	return errors;
}

export const fuels = FUELS;

/** A preset ticked in the add form, with its first due date. */
export type PresetPicks = Record<PresetId, PresetPickState>;
export const freshPicks = (): PresetPicks =>
	Object.fromEntries(VEHICLE_PRESETS.map((p) => [p.id, freshPick(p)])) as PresetPicks;
