import { type AddObligationInput, scheduleOf } from '@famos/ext-records/contract';
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
	AddLogSchema,
	AddVehicleSchema,
	RECORD_KIND,
	UpdateVehicleSchema,
	VEHICLE_AUDIENCE,
	VEHICLE_PRESETS,
	VehicleFieldsSchema,
	VehicleIdSchema,
	VehicleLogIdSchema,
	VehicleLogSchema,
	VehicleSchema,
	vehicleChangedPayload,
	vehicleUrl,
} from '../contract/index.ts';
import { vehiclesEdit, vehiclesView } from './capabilities.ts';
import { tables, toLog, toVehicle, type VehicleRow } from './store.ts';

export const vehicleChanged = defineEvent('vehicles.vehicle.changed', vehicleChangedPayload);

const memberId = (actor: Actor) => (actor.kind === 'member' ? actor.memberId : null);

async function assertMembers(uow: UnitOfWork, ids: readonly string[]) {
	if (ids.length === 0) return;
	const active = new Set((await uow.family.members()).map((m) => m.id));
	const unknown = ids.find((id) => !active.has(id));
	if (unknown) throw new FamosError('bad_request', `Unknown member: ${unknown}`);
}

async function load(uow: UnitOfWork, id: string): Promise<VehicleRow> {
	const row = await tables(uow.db)
		.selectFrom('vehicles_vehicles')
		.selectAll()
		.where('id', '=', id)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Vehicle not found');
	return row;
}

const fieldsOf = (v: z.output<typeof VehicleFieldsSchema>) => ({
	name: v.name,
	plate: v.plate,
	make: v.make,
	model: v.model,
	year: v.year ?? null,
	fuel: v.fuel,
	vin: v.vin || null,
	member_ids: JSON.stringify([...new Set(v.memberIds)]),
	notes: v.notes || null,
});

export const addVehicle = defineAction({
	id: 'vehicles.addVehicle',
	title: 'Add a vehicle',
	draftTitle: 'vehicles:draft_title_add_vehicle',
	input: AddVehicleSchema,
	output: VehicleSchema,
	approval: { unless: vehiclesEdit.id },
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('vehicles_vehicles')
			.select('id')
			.where('archived_at', 'is', null)
			.where((eb) =>
				input.plate
					? eb.or([eb('name', '=', input.name), eb('plate', '=', input.plate)])
					: eb('name', '=', input.name),
			)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, { obligations, ...input }) {
		await assertMembers(uow, input.memberIds);
		const now = uow.clock.now();
		const row: VehicleRow = {
			id: uow.ids.next('vehicle'),
			...fieldsOf({ ...input, memberIds: input.memberIds }),
			created_by: memberId(uow.actor),
			created_at: now,
			updated_at: now,
			archived_at: null,
		};
		await tables(uow.db).insertInto('vehicles_vehicles').values(row).execute();
		// What usually needs doing, as picked: the repeat and lead time are the person's, the preset only suggests them.
		for (const pick of obligations) {
			const preset = VEHICLE_PRESETS.find((p) => p.id === pick.preset);
			if (!preset) throw new FamosError('bad_request', `Unknown preset: ${pick.preset}`);
			const obligation: AddObligationInput = {
				recordId: row.id,
				recordKind: RECORD_KIND,
				recordName: row.name,
				recordUrl: vehicleUrl(row.id),
				kind: preset.id,
				title: pick.title,
				dueDate: pick.dueDate,
				...scheduleOf(preset, pick),
				audience: VEHICLE_AUDIENCE,
			};
			await uow.run('records.addObligation', obligation);
		}
		uow.emit(vehicleChanged, { vehicleId: row.id });
		return toVehicle(row);
	},
});

export const updateVehicle = defineAction({
	id: 'vehicles.updateVehicle',
	title: 'Change a vehicle',
	draftTitle: 'vehicles:draft_title_update_vehicle',
	input: UpdateVehicleSchema,
	// Waiting from when a field left out meant empty (or its default): read that way.
	storedInput: storedAsWhole(VehicleFieldsSchema, 'vehicle'),
	output: VehicleSchema,
	approval: { unless: vehiclesEdit.id },
	async run(uow, { id, vehicle }) {
		const row = await load(uow, id);
		await assertMembers(uow, vehicle.memberIds);
		const patch = { ...fieldsOf(vehicle), updated_at: uow.clock.now() };
		await tables(uow.db).updateTable('vehicles_vehicles').set(patch).where('id', '=', id).execute();
		// Lists that span records ("Coming up", reminders) show the name.
		if (patch.name !== row.name) {
			await uow.run('records.renameRecord', {
				recordId: id,
				name: patch.name,
				url: vehicleUrl(id),
			});
		}
		uow.emit(vehicleChanged, { vehicleId: id });
		return toVehicle({ ...row, ...patch });
	},
});

/** Hides the vehicle and its obligations and papers (kept, no more reminders). */
export const archiveVehicle = defineAction({
	id: 'vehicles.archiveVehicle',
	title: 'Archive a vehicle',
	draftTitle: 'vehicles:draft_title_archive_vehicle',
	input: z.object({ id: VehicleIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: vehiclesEdit.id },
	async run(uow, { id }) {
		await load(uow, id);
		const now = uow.clock.now();
		await tables(uow.db)
			.updateTable('vehicles_vehicles')
			.set({ archived_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		await uow.run('records.archiveForRecord', { recordId: id });
		uow.emit(vehicleChanged, { vehicleId: id });
		return { ok: true as const };
	},
});

export const addLog = defineAction({
	id: 'vehicles.addLog',
	title: 'Add a service or repair entry',
	draftTitle: 'vehicles:draft_title_add_log',
	input: AddLogSchema,
	output: VehicleLogSchema,
	approval: { unless: vehiclesEdit.id },
	// The vehicle by its name on record: a form sends only its id.
	async subject(ctx, { vehicleId }) {
		const row = await tables(ctx.db)
			.selectFrom('vehicles_vehicles')
			.select('name')
			.where('id', '=', vehicleId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		return row?.name ?? null;
	},
	undo: (log) => ({ actionId: 'vehicles.removeLog', input: { id: log.id } }),
	ai: {
		description:
			'Record a service or repair of a household vehicle from an invoice, a service receipt or a message: the date, the place and what was done. The vehicle must be one of the household vehicles.',
		guidance:
			'vehicleId is the vehicle’s reference from the vehicles list; look the vehicle up first, and when it is not there, say so instead. doneOn is the date of the work. kind is service for regular maintenance, repair for fixing something, other otherwise. place is the garage. notes say what was done in a few words; a mileage may be written there. Do not put amounts of money anywhere. vehicleName is the vehicle as listed.',
	},
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('vehicles_logs')
			.select('id')
			.where('vehicle_id', '=', input.vehicleId)
			.where('done_on', '=', input.doneOn)
			.where('kind', '=', input.kind)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, input) {
		await load(uow, input.vehicleId);
		const row = {
			id: uow.ids.next('vehicle_log'),
			vehicle_id: input.vehicleId,
			kind: input.kind,
			done_on: input.doneOn,
			place: input.place || null,
			notes: input.notes || null,
			document_id: input.documentId ?? null,
			created_by: memberId(uow.actor),
			created_at: uow.clock.now(),
		};
		await tables(uow.db).insertInto('vehicles_logs').values(row).execute();
		uow.emit(vehicleChanged, { vehicleId: input.vehicleId });
		return toLog(row);
	},
});

export const removeLog = defineAction({
	id: 'vehicles.removeLog',
	title: 'Remove a service or repair entry',
	draftTitle: 'vehicles:draft_title_remove_log',
	input: z.object({ id: VehicleLogIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: vehiclesEdit.id },
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('vehicles_logs')
			.select('vehicle_id')
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Entry not found');
		await tables(uow.db).deleteFrom('vehicles_logs').where('id', '=', id).execute();
		uow.emit(vehicleChanged, { vehicleId: row.vehicle_id });
		return { ok: true as const };
	},
});

const MAX_CONTEXT = 50;
const FUEL_WORDS = {
	petrol: 'petrol',
	diesel: 'diesel',
	hybrid: 'hybrid',
	electric: 'electric',
	lpg: 'LPG',
	other: '',
} as const;

/**
 * What the AI may know about the household's vehicles, so a shared policy or invoice can name
 * the right one. Read by the Inbox as the AI actor; a locked area refuses it. No VIN, no notes.
 */
export const aiContext = defineAction({
	id: 'vehicles.aiContext',
	title: 'Vehicles, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: vehiclesView.id,
	ai: {
		description:
			'Lists the household vehicles: name, plate, make, model, year and fuel. Use it to find which vehicle a question is about.',
	},
	async run(uow) {
		const rows = await tables(uow.db)
			.selectFrom('vehicles_vehicles')
			.selectAll()
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.limit(MAX_CONTEXT)
			.execute();
		return {
			kind: RECORD_KIND,
			label: 'Vehicles',
			items: rows.map((r) => {
				const details = [
					r.plate,
					[r.make, r.model, r.year].filter(Boolean).join(' '),
					FUEL_WORDS[r.fuel],
				]
					.filter(Boolean)
					.join(', ');
				return {
					id: r.id,
					label: r.name,
					...(details && { details }),
					url: vehicleUrl(r.id),
				};
			}),
		};
	},
});

export const listVehicles = defineRoute({
	method: 'get',
	path: '/vehicles',
	operationId: 'vehicles.listVehicles',
	summary: 'The household’s vehicles',
	requires: vehiclesView.id,
	response: z.array(VehicleSchema),
	async handle(ctx) {
		const rows = await tables(ctx.db)
			.selectFrom('vehicles_vehicles')
			.selectAll()
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.orderBy('id')
			.execute();
		return rows.map(toVehicle);
	},
});

export const getVehicle = defineRoute({
	method: 'get',
	path: '/vehicles/{vehicleId}',
	operationId: 'vehicles.getVehicle',
	summary: 'One vehicle',
	requires: vehiclesView.id,
	params: z.object({ vehicleId: VehicleIdSchema }),
	response: VehicleSchema,
	async handle(ctx, { params }) {
		const row = await tables(ctx.db)
			.selectFrom('vehicles_vehicles')
			.selectAll()
			.where('id', '=', params.vehicleId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Vehicle not found');
		return toVehicle(row);
	},
});

export const listLogs = defineRoute({
	method: 'get',
	path: '/vehicles/{vehicleId}/logs',
	operationId: 'vehicles.listLogs',
	summary: 'The service and repair log of a vehicle, newest first',
	requires: vehiclesView.id,
	params: z.object({ vehicleId: VehicleIdSchema }),
	response: z.array(VehicleLogSchema),
	async handle(ctx, { params }) {
		const rows = await tables(ctx.db)
			.selectFrom('vehicles_logs')
			.selectAll()
			.where('vehicle_id', '=', params.vehicleId)
			.orderBy('done_on', 'desc')
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.execute();
		return rows.map(toLog);
	},
});
