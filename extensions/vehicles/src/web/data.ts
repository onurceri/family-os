import { unwrap } from '@famos/api-client';
import type { RecordDocument } from '@famos/ext-records/contract';
import type {
	AddLogInput,
	AddVehicleInput,
	Vehicle,
	VehicleLog,
	VehicleReplace,
} from '../contract/index.js';
import { api } from './api.js';

/** Vehicles API calls, all through the generated client. */
export type Outcome = 'applied' | 'drafted';

export const loadVehicles = async (): Promise<Vehicle[]> =>
	unwrap(await api.GET('/api/v1/vehicles/vehicles'));

export const loadVehicle = async (vehicleId: string): Promise<Vehicle> =>
	unwrap(
		await api.GET('/api/v1/vehicles/vehicles/{vehicleId}', { params: { path: { vehicleId } } }),
	);

export const loadLogs = async (vehicleId: string): Promise<VehicleLog[]> =>
	unwrap(
		await api.GET('/api/v1/vehicles/vehicles/{vehicleId}/logs', {
			params: { path: { vehicleId } },
		}),
	);

/** The papers filed to a vehicle (records), to link one to a log entry. */
export const loadPapers = async (recordId: string): Promise<RecordDocument[]> =>
	unwrap(await api.GET('/api/v1/records/documents', { params: { query: { recordId } } }));

/** What the form saves: the whole vehicle, null for a field left empty. */
export type VehicleValues = VehicleReplace;

export async function addVehicle(
	input: AddVehicleInput,
): Promise<{ outcome: Outcome; id: string | null }> {
	const result = unwrap(await api.POST('/api/v1/actions/vehicles.addVehicle', { body: input }));
	return { outcome: result.status, id: result.status === 'applied' ? result.output.id : null };
}

export async function updateVehicle(id: string, vehicle: VehicleValues): Promise<Outcome> {
	return unwrap(await api.POST('/api/v1/actions/vehicles.updateVehicle', { body: { id, vehicle } }))
		.status;
}

export const archiveVehicle = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/vehicles.archiveVehicle', { body: { id } })).status;

export const addLog = async (input: AddLogInput): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/vehicles.addLog', { body: input })).status;

export const removeLog = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/vehicles.removeLog', { body: { id } })).status;
