import inbox from '@famos/ext-inbox/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import vehicles from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let clio: { id: string };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [records, vehicles, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin', 'Ayşe');
	const add = async (input: Record<string, unknown>) => {
		const r = await k.runner.invoke<{ id: string }>('vehicles.addVehicle', input, admin.actor);
		if (r.status !== 'applied') throw new Error('expected applied');
		return r.output;
	};
	clio = await add({
		name: 'Clio',
		plate: '34 ABC 123',
		fuel: 'petrol',
		obligations: [
			{ preset: 'comprehensive_insurance', title: 'Car insurance', dueDate: '2026-11-01' },
		],
	});
	await add({ name: 'Golf', plate: '06 XYZ 99', fuel: 'diesel' });
});
afterEach(() => k.close());

const read = async (text = 'Your car insurance was renewed; it is valid until 12.03.2027.') => {
	await k.route('inbox.createItem').call({
		body: { channel: 'share', text },
		files: [],
		actor: admin.actor,
	});
	await k.worker.drain();
};
const drafts = (): Promise<{ id: string; actionId: string; input: Record<string, unknown> }[]> =>
	k.route('core.listDrafts').call({
		query: { sourceKind: 'inbox', limit: 50 },
		actor: admin.actor,
	});
const seenByModel = () =>
	JSON.stringify(
		k.llm.calls.map(({ system, prompt, areas, jsonSchema }) => ({
			system,
			prompt,
			areas,
			jsonSchema,
		})),
	);

describe('household records in the prompt', () => {
	it('lists vehicles and open obligations by handle, and never an id', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await read();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('Household records');
		expect(system).toContain('Vehicles:');
		expect(system).toContain('- Clio (vehicle:1): 34 ABC 123, petrol');
		expect(system).toContain('- Golf (vehicle:2): 06 XYZ 99, diesel');
		expect(system).toContain('- Car insurance (Clio) (obligation:1): due 2026-11-01, every year');
		expect(seenByModel()).not.toMatch(/vehicle_[0-9a-f]{8}|obligation_[0-9a-f]{8}/);
		expect(k.llm.calls[0]?.areas).toEqual(expect.arrayContaining(['inbox', 'vehicles', 'records']));
	});

	it('keeps vehicles and their duties out while the area is locked, though records is open', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'off' },
			admin.actor,
		);
		k.llm.respond({ summary: 'x', proposals: [] });
		await read();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).not.toContain('Vehicles:');
		expect(system).not.toContain('Clio (');
		expect(system).not.toContain('vehicles.addLog');
		expect(system).not.toContain('(vehicle:');
		// Records is still open, but a vehicle's duties belong to the vehicles area: names, dates
		// and all stay out of the prompt while it is locked.
		expect(system).not.toMatch(/34 ABC|2026-11-01|\(obligation:\d\)|\(vehicle:\d\)/);
		expect(system).not.toContain('Household records');
		expect(system).toContain('records.addObligation');
		expect(k.llm.calls[0]?.areas).not.toContain('vehicles');
	});
});

describe('proposals that name a record', () => {
	it('turns "car insurance renewed until 2027-03-12" into a draft that moves the due date', async () => {
		k.llm.respond({
			summary: 'Car insurance renewed',
			proposals: [
				{
					action: 'records.completeObligation',
					input: {
						id: 'obligation:1',
						doneOn: '2026-10-06',
						nextDueDate: '2027-03-12',
						label: 'Car insurance (Clio)',
					},
					dateText: '12.03.2027',
					confidence: 0.9,
				},
			],
		});
		await read();
		const [draft] = await drafts();
		expect(draft?.actionId).toBe('records.completeObligation');
		expect(draft?.input).toMatchObject({ nextDueDate: '2027-03-12' });
		expect(String(draft?.input.id)).toMatch(/^obligation_/);

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		const open = await k.route('records.listObligations').call({
			query: { recordId: clio.id, status: 'open' },
		});
		expect(open).toMatchObject([
			{ title: 'Car insurance', dueDate: '2027-03-12', lastDoneOn: '2026-10-06' },
		]);
	});

	it('skips a completion the app refuses, and still reads the item', async () => {
		// Real model output for a renewal notice: the duty marked done with no day it was done.
		// Records refuses it; that used to fail the whole item instead of skipping one suggestion.
		k.llm.respond({
			summary: 'Car insurance renewal',
			proposals: [
				{
					action: 'records.completeObligation',
					input: { id: 'obligation:1', dueDate: '2026-11-01', label: 'Car insurance (Clio)' },
					confidence: 0.8,
				},
			],
		});
		await read('Your car insurance is due for renewal on 1 November. Renew before then.');
		expect(await drafts()).toHaveLength(0);
		const [item] = (await k.route('inbox.listItems').call({
			query: { limit: 5 },
			actor: admin.actor,
		})) as { status: string; proposals: number; skipped: number }[];
		expect(item).toMatchObject({ status: 'extracted', proposals: 0, skipped: 1 });
	});

	it('maps the vehicle of a service entry too', async () => {
		k.llm.respond({
			summary: 'Servis faturası',
			proposals: [
				{
					action: 'vehicles.addLog',
					input: { vehicleId: 'vehicle:1', doneOn: '2026-10-01', notes: 'Yağ değişimi' },
					dateText: '1 Ekim',
					confidence: 0.9,
				},
			],
		});
		await read('Servis faturası 1 Ekim 2026, yağ değişimi');
		const [draft] = await drafts();
		expect(draft?.input).toMatchObject({ vehicleId: clio.id, doneOn: '2026-10-01' });
	});
});
