import { FamosError, type UnitOfWork } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { addPickedObligations, recordDueDigest } from '../src/contract/index.ts';

const PRESETS = [
	{ id: 'inspection', titleKey: 'x:inspection', every: { years: 2 }, leadDays: 30 },
	{ id: 'warranty', titleKey: 'x:warranty' },
];
const record = {
	id: 'vehicle_00000000-0000-7000-8000-000000000001',
	kind: 'vehicle',
	name: 'Golf',
	url: '/vehicles/vehicle_1',
	audience: 'vehicles.view',
	presets: PRESETS,
};

function recorder() {
	const calls: { id: string; input: unknown }[] = [];
	const uow = {
		run: async (id: string, input: unknown) => {
			calls.push({ id, input });
		},
	} as unknown as UnitOfWork;
	return { uow, calls };
}

describe('addPickedObligations', () => {
	it('adds each pick with the preset suggestion unless the person chose', async () => {
		const { uow, calls } = recorder();
		await addPickedObligations(uow, record, [
			{ preset: 'inspection', title: 'Inspection', dueDate: '2027-01-01' },
			{ preset: 'inspection', title: 'Again', dueDate: '2027-02-01', every: null, leadDays: 3 },
			{ preset: 'warranty', title: 'Warranty', dueDate: '2027-03-01' },
		]);
		expect(calls.map((c) => c.id)).toEqual(Array(3).fill('records.addObligation'));
		expect(calls[0]?.input).toEqual({
			recordId: record.id,
			recordKind: 'vehicle',
			recordName: 'Golf',
			recordUrl: '/vehicles/vehicle_1',
			kind: 'inspection',
			title: 'Inspection',
			dueDate: '2027-01-01',
			every: { years: 2 },
			leadDays: 30,
			audience: 'vehicles.view',
		});
		expect(calls[1]?.input).toMatchObject({ every: undefined, leadDays: 3 });
		expect(calls[2]?.input).toMatchObject({ every: undefined, leadDays: 14 });
	});

	it('refuses an unknown preset', async () => {
		const { uow } = recorder();
		const failure = await addPickedObligations(uow, record, [
			{ preset: 'nope', title: 'X', dueDate: '2027-01-01' },
		]).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(FamosError);
		expect((failure as FamosError).code).toBe('bad_request');
	});
});

describe('recordDueDigest', () => {
	it('asks records for the duties of its kind in the span', async () => {
		const digest = recordDueDigest({
			id: 'vehicles.digest',
			topic: 'vehicles',
			title: 'T',
			description: 'D',
			requires: 'vehicles.view',
			recordKind: 'vehicle',
		});
		expect(digest.id).toBe('vehicles.digest');
		expect(digest.readOnly).toBe(true);
		const { uow, calls } = recorder();
		const span = { from: '2026-10-06', to: '2026-10-12' };
		await digest.run(uow, span);
		expect(calls).toEqual([
			{ id: 'records.dueBetween', input: { span, recordKinds: ['vehicle'] } },
		]);
	});
});
