import type { Obligation } from '@famos/ext-records/contract';
import { FamosError } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	PRESET_IDS,
	VEHICLE_PRESETS,
	type Vehicle,
	type VehicleLog,
	vehicleUrl,
} from '../src/contract/index.ts';
import { AI, applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
});
afterEach(() => k.close());

const addVehicle = (input: Record<string, unknown> = {}, actor = admin.actor) =>
	applied<Vehicle>(
		k,
		'vehicles.addVehicle',
		{ name: 'Clio', plate: '34 ABC 123', make: 'Renault', model: 'Clio', year: 2019, ...input },
		actor,
	);
const vehicles = (): Promise<Vehicle[]> => k.route('vehicles.listVehicles').call();
const obligations = (recordId: string, status = 'open'): Promise<Obligation[]> =>
	k.route('records.listObligations').call({ query: { recordId, status } });
const logs = (vehicleId: string): Promise<VehicleLog[]> =>
	k.route('vehicles.listLogs').call({ params: { vehicleId } });

describe('vehicles', () => {
	it('adds, lists, reads and changes a vehicle', async () => {
		const car = await addVehicle({ fuel: 'petrol', vin: 'WVW123', notes: 'Spare key at Ayşe’s' });
		expect(car).toMatchObject({ name: 'Clio', plate: '34 ABC 123', year: 2019, fuel: 'petrol' });
		expect(car.id).toMatch(/^vehicle_/);
		expect(await vehicles()).toHaveLength(1);
		expect(
			await k.route('vehicles.getVehicle').call({ params: { vehicleId: car.id } }),
		).toMatchObject({ vin: 'WVW123', memberIds: [] });

		const changed = await applied<Vehicle>(
			k,
			'vehicles.updateVehicle',
			{
				id: car.id,
				vehicle: {
					name: 'Clio',
					plate: '06 XYZ 99',
					make: '',
					model: 'Clio',
					year: 2019,
					fuel: 'diesel',
					vin: null,
					memberIds: [admin.id],
					notes: null,
				},
			},
			admin.actor,
		);
		expect(changed).toMatchObject({
			plate: '06 XYZ 99',
			make: '',
			fuel: 'diesel',
			vin: null,
			memberIds: [admin.id],
		});
		// The form always sends the whole vehicle: one that leaves fields out is refused, not cleared.
		await expect(
			k.runner.invoke(
				'vehicles.updateVehicle',
				{ id: car.id, vehicle: { name: 'Clio', plate: '34 ABC 123' } },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(
			await k.route('vehicles.getVehicle').call({ params: { vehicleId: car.id } }),
		).toMatchObject({ plate: '06 XYZ 99', model: 'Clio', year: 2019 });
	});

	it('refuses an unknown member, a bad year and a missing name', async () => {
		const fail = (input: Record<string, unknown>) =>
			addVehicle(input).then(
				() => null,
				(e: unknown) => e,
			);
		expect(
			await fail({ memberIds: ['member_00000000-0000-7000-8000-000000000999'] }),
		).toBeInstanceOf(FamosError);
		expect(await fail({ year: 1800 })).toBeInstanceOf(FamosError);
		expect(await fail({ name: '  ' })).toBeInstanceOf(FamosError);
		expect(await vehicles()).toHaveLength(0);
	});

	it('answers not found for an unknown vehicle', async () => {
		await expect(
			k
				.route('vehicles.getVehicle')
				.call({ params: { vehicleId: 'vehicle_00000000-0000-7000-8000-000000000001' } }),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('what usually needs doing', () => {
	it('creates the picked obligations with the preset’s repeat and lead time', async () => {
		const car = await addVehicle({
			obligations: [
				{ preset: 'comprehensive_insurance', title: 'Car insurance', dueDate: '2026-11-20' },
				{ preset: 'inspection', title: 'Inspection', dueDate: '2027-02-01' },
				{ preset: 'vehicle_tax', title: 'Road tax', dueDate: '2027-01-31' },
			],
		});
		const list = await obligations(car.id);
		expect(list.map((o) => o.title)).toEqual(['Car insurance', 'Road tax', 'Inspection']);
		expect(list).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'comprehensive_insurance',
					dueDate: '2026-11-20',
					every: { years: 1 },
					leadDays: 30,
					audience: 'vehicles.view',
					recordKind: 'vehicle',
					recordName: 'Clio',
					recordUrl: vehicleUrl(car.id),
				}),
				expect.objectContaining({ kind: 'inspection', every: { years: 1 }, dueDate: '2027-02-01' }),
				expect.objectContaining({ kind: 'vehicle_tax', every: { years: 1 }, leadDays: 14 }),
			]),
		);
	});

	it('moves the next date by the preset’s cycle when one is done', async () => {
		const car = await addVehicle({
			obligations: [{ preset: 'tyres', title: 'Tyres', dueDate: '2026-10-20' }],
		});
		const [tyres] = await obligations(car.id);
		const done = await applied<Obligation>(
			k,
			'records.completeObligation',
			{ id: tyres?.id, doneOn: '2026-10-10' },
			admin.actor,
		);
		expect(done.dueDate).toBe('2027-04-20');
	});

	it('refuses a preset that does not exist and adds nothing', async () => {
		await expect(
			addVehicle({ obligations: [{ preset: 'flying', title: 'x', dueDate: '2026-11-20' }] }),
		).rejects.toBeInstanceOf(FamosError);
		expect(await vehicles()).toHaveLength(0);
	});

	it('declares every preset with a title key and a repeat', () => {
		expect(VEHICLE_PRESETS.map((p) => p.id)).toEqual(PRESET_IDS);
		for (const preset of VEHICLE_PRESETS) {
			expect(preset.titleKey).toMatch(/^vehicles:preset_/);
			expect(preset.every).toBeDefined();
		}
	});
});

describe('the person sets the schedule', () => {
	it('takes the interval and lead time the person chose instead of the preset’s', async () => {
		const car = await addVehicle({
			obligations: [
				{
					preset: 'inspection',
					title: 'Inspection',
					dueDate: '2027-02-01',
					every: { years: 2 },
					leadDays: 60,
				},
				{ preset: 'vehicle_tax', title: 'Road tax', dueDate: '2027-01-31', every: { months: 6 } },
				{ preset: 'tyres', title: 'Tyres', dueDate: '2026-10-20', every: null },
			],
		});
		const byKind = Object.fromEntries((await obligations(car.id)).map((o) => [o.kind, o]));
		expect(byKind.inspection).toMatchObject({ every: { years: 2 }, leadDays: 60 });
		// Only the interval was given: the lead time is the preset's.
		expect(byKind.vehicle_tax).toMatchObject({ every: { months: 6 }, leadDays: 14 });
		// "Does not repeat".
		expect(byKind.tyres).toMatchObject({ every: null, leadDays: 14 });
	});

	it('refuses an interval or lead time out of range', async () => {
		for (const bad of [{ every: { months: 0 } }, { every: { years: 99 } }, { leadDays: 400 }]) {
			await expect(
				addVehicle({
					obligations: [{ preset: 'service', title: 'Service', dueDate: '2027-02-01', ...bad }],
				}),
			).rejects.toThrow();
		}
		expect(await vehicles()).toHaveLength(0);
	});

	it('still lists and completes an obligation made from a preset that no longer exists', async () => {
		const car = await addVehicle();
		const now = Date.now();
		await k.ctx.db
			.withTables<{ records_obligations: Record<string, string | number | null> }>()
			.insertInto('records_obligations')
			.values({
				id: 'obligation_00000000-0000-7000-8000-0000000000aa',
				record_id: car.id,
				record_kind: 'vehicle',
				record_name: 'Clio',
				record_url: vehicleUrl(car.id),
				kind: 'kasko',
				title: 'Kasko',
				due_date: '2026-11-20',
				rrule: 'FREQ=YEARLY;INTERVAL=1',
				rrule_start: '2026-11-20',
				lead_days: 30,
				audience: 'vehicles.view',
				created_at: now,
				updated_at: now,
			})
			.execute();
		const [old] = await obligations(car.id);
		expect(old).toMatchObject({ kind: 'kasko', title: 'Kasko', every: { years: 1 } });
		const done = await applied<Obligation>(
			k,
			'records.completeObligation',
			{ id: old?.id, doneOn: '2026-11-01' },
			admin.actor,
		);
		expect(done.dueDate).toBe('2027-11-20');
	});
});

describe('records follow the vehicle', () => {
	it('renames the record when the name changes, and only then', async () => {
		const car = await addVehicle({
			obligations: [
				{ preset: 'comprehensive_insurance', title: 'Car insurance', dueDate: '2026-11-20' },
			],
		});
		const update = (name: string) =>
			applied(
				k,
				'vehicles.updateVehicle',
				{
					id: car.id,
					vehicle: {
						name,
						plate: '34 ABC 123',
						make: 'Renault',
						model: 'Clio',
						year: 2019,
						fuel: 'other',
						vin: null,
						memberIds: [],
						notes: null,
					},
				},
				admin.actor,
			);
		await update('Clio 2');
		expect((await obligations(car.id))[0]).toMatchObject({
			recordName: 'Clio 2',
			recordUrl: vehicleUrl(car.id),
		});
	});

	it('archives the vehicle with its obligations, and hides it everywhere', async () => {
		const car = await addVehicle({
			obligations: [
				{ preset: 'comprehensive_insurance', title: 'Car insurance', dueDate: '2026-11-20' },
			],
		});
		await addVehicle({ name: 'Golf', plate: '' });
		await applied(k, 'vehicles.archiveVehicle', { id: car.id }, admin.actor);
		expect((await vehicles()).map((v) => v.name)).toEqual(['Golf']);
		expect(await obligations(car.id)).toHaveLength(0);
		expect(await obligations(car.id, 'archived')).toHaveLength(1);
		await expect(
			k.route('vehicles.getVehicle').call({ params: { vehicleId: car.id } }),
		).rejects.toMatchObject({ code: 'not_found' });
		const context = await applied<{ items: { label: string }[] }>(k, 'vehicles.aiContext', {}, AI);
		expect(context.items.map((i) => i.label)).toEqual(['Golf']);
		// Archiving again says so instead of pretending.
		await expect(
			applied(k, 'vehicles.archiveVehicle', { id: car.id }, admin.actor),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('service and repair log', () => {
	it('adds entries, lists the newest first and removes one', async () => {
		const car = await addVehicle();
		const log = (input: Record<string, unknown>) =>
			applied<VehicleLog>(k, 'vehicles.addLog', { vehicleId: car.id, ...input }, admin.actor);
		await log({ doneOn: '2026-03-01', place: 'Oto Servis', notes: '45.200 km, oil and filters' });
		const repair = await log({ kind: 'repair', doneOn: '2026-08-15', notes: 'Brake pads' });
		expect((await logs(car.id)).map((l) => [l.kind, l.doneOn])).toEqual([
			['repair', '2026-08-15'],
			['service', '2026-03-01'],
		]);
		expect((await logs(car.id))[1]).toMatchObject({ place: 'Oto Servis', createdBy: admin.id });
		await applied(k, 'vehicles.removeLog', { id: repair.id }, admin.actor);
		expect(await logs(car.id)).toHaveLength(1);
		await expect(
			applied(k, 'vehicles.removeLog', { id: repair.id }, admin.actor),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('refuses an entry for an unknown or archived vehicle, and a bad date', async () => {
		const car = await addVehicle();
		const add = (vehicleId: string, doneOn = '2026-03-01') =>
			applied(k, 'vehicles.addLog', { vehicleId, doneOn }, admin.actor);
		await expect(add('vehicle_00000000-0000-7000-8000-000000000001')).rejects.toMatchObject({
			code: 'not_found',
		});
		await expect(add(car.id, '2026-13-01')).rejects.toBeInstanceOf(FamosError);
		await applied(k, 'vehicles.archiveVehicle', { id: car.id }, admin.actor);
		await expect(add(car.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('keeps the reviewer-only vehicle name out of storage', async () => {
		const car = await addVehicle();
		const log = await applied<VehicleLog & { vehicleName?: string }>(
			k,
			'vehicles.addLog',
			{ vehicleId: car.id, doneOn: '2026-03-01', vehicleName: 'Clio' },
			admin.actor,
		);
		expect(log).not.toHaveProperty('vehicleName');
	});
});

describe('a log entry sent for approval', () => {
	it('names the vehicle it is for, though the form sends only its id', async () => {
		const car = await addVehicle();
		const kid = await person(k, 'supervised', 'Elif');
		const result = await k.runner.invoke(
			'vehicles.addLog',
			{ vehicleId: car.id, doneOn: '2026-08-15' },
			kid.actor,
		);
		expect(result).toMatchObject({ status: 'drafted', subject: car.name });
	});
});

describe('capabilities', () => {
	it('turns a supervised member’s changes into drafts that an admin approves', async () => {
		const kid = await person(k, 'supervised', 'Elif');
		const result = await k.runner.invoke('vehicles.addVehicle', { name: 'Bike' }, kid.actor);
		expect(result.status).toBe('drafted');
		expect(await vehicles()).toHaveLength(0);
		if (result.status !== 'drafted') return;
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect((await vehicles()).map((v) => v.name)).toEqual(['Bike']);
		// They may look, though.
		expect(await k.route('vehicles.listVehicles').call({ actor: kid.actor })).toHaveLength(1);
	});

	it('lets the AI propose a log entry only as a draft', async () => {
		const car = await addVehicle();
		const result = await k.runner.invoke(
			'vehicles.addLog',
			{ vehicleId: car.id, doneOn: '2026-10-01', notes: 'Oil change' },
			AI,
		);
		expect(result.status).toBe('drafted');
		expect(await logs(car.id)).toHaveLength(0);
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).toContain('vehicles.addLog');
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).not.toContain('vehicles.addVehicle');
	});
});

describe('AI context', () => {
	it('lists vehicles with short details, a path and neither VIN nor notes', async () => {
		await addVehicle({ fuel: 'petrol', vin: 'SECRETVIN', notes: 'private note' });
		const context = await applied<unknown>(k, 'vehicles.aiContext', {}, AI);
		expect(context).toMatchObject({
			kind: 'vehicle',
			label: 'Vehicles',
			items: [{ label: 'Clio', details: '34 ABC 123, Renault Clio 2019, petrol' }],
		});
		expect(JSON.stringify(context)).not.toMatch(/SECRETVIN|private note/);
	});

	it('is refused for the AI when the area is off, and still open to people', async () => {
		await addVehicle();
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'off' },
			admin.actor,
		);
		await expect(k.runner.invoke('vehicles.aiContext', {}, AI)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.invoke('vehicles.aiContext', {}, admin.actor)).resolves.toMatchObject({
			status: 'applied',
		});
	});

	it('keeps a locked vehicles area’s obligations out of records’ context too', async () => {
		const car = await addVehicle({
			obligations: [
				{ preset: 'comprehensive_insurance', title: 'Car insurance', dueDate: '2026-11-20' },
			],
		});
		await applied(
			k,
			'records.addObligation',
			{
				recordId: 'pet_00000000-0000-7000-8000-000000000001',
				recordKind: 'pet',
				recordName: 'Pamuk',
				title: 'Rabies',
				dueDate: '2026-12-01',
			},
			admin.actor,
		);
		const labels = async (actor: typeof AI) =>
			(await applied<{ items: { label: string }[] }>(k, 'records.aiContext', {}, actor)).items.map(
				(i) => i.label,
			);
		expect(await labels(AI)).toEqual(['Car insurance (Clio)', 'Rabies (Pamuk)']);
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'off' },
			admin.actor,
		);
		// The pet duty has the default audience; the vehicle's is gone for the AI, not for people.
		expect(await labels(AI)).toEqual(['Rabies (Pamuk)']);
		expect(await labels(admin.actor)).toEqual(['Car insurance (Clio)', 'Rabies (Pamuk)']);
		expect(car.id).toBeTruthy();
	});

	it('is named by the extension and is read-only', () => {
		const ext = k.registry.extensions.find((e) => e.id === 'vehicles');
		expect(ext?.ai?.context).toBe('vehicles.aiContext');
		expect(k.registry.actions.get('vehicles.aiContext')?.readOnly).toBe(true);
	});
});
