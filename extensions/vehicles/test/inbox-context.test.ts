import inbox from '@famos/ext-inbox/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, mention, type TestKernel, understood } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import vehicles from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let clio: { id: string };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [records, vehicles, inbox] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, formatLocale: 'tr-TR' },
		systemActor('test'),
	);
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
	it('lists vehicles and open obligations by name, and never an id or a handle', async () => {
		k.llm.respond(understood());
		await read();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('Vehicles:');
		expect(system).toContain('- Clio (34 ABC 123, petrol)');
		expect(system).toContain('- Golf (06 XYZ 99, diesel)');
		expect(system).toContain('- Car insurance (Clio) (due 2026-11-01, every year)');
		expect(seenByModel()).not.toMatch(/vehicle_[0-9a-f]{8}|obligation_[0-9a-f]{8}|vehicle:1/);
		expect(k.llm.calls[0]?.areas).toEqual(expect.arrayContaining(['inbox', 'vehicles', 'records']));
	});

	it('keeps vehicles and their duties out while the area is locked, though records is open', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'off' },
			admin.actor,
		);
		k.llm.respond(understood());
		await read();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).not.toContain('Vehicles:');
		expect(system).not.toContain('- Clio');
		expect(system).not.toContain('vehicles.log');
		// Records is still open, but a vehicle's duties belong to the vehicles area: names, dates
		// and all stay out of the prompt while it is locked.
		expect(system).not.toMatch(/34 ABC|2026-11-01|Car insurance \(Clio\)/);
		expect(system).toContain('### records.duty');
		expect(k.llm.calls[0]?.areas).not.toContain('vehicles');
	});
});

describe('mentions that name a record', () => {
	it('turns "car insurance renewed until 12.03.2027" into a draft that moves the due date', async () => {
		k.llm.respond(
			understood([
				mention('records.dutyDone', {
					target: 'car insurance',
					date: { text: 'renewed', inDays: 0 },
					endDate: { text: '12.03.2027', numeric: '12.03.2027' },
				}),
			]),
		);
		await read();
		const [draft] = await drafts();
		expect(draft?.actionId).toBe('records.completeObligation');
		expect(draft?.input).toMatchObject({ nextDueDate: '2027-03-12', doneOn: '2026-10-06' });
		expect(String(draft?.input.id)).toMatch(/^obligation_/);

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		const open = await k.route('records.listObligations').call({
			query: { recordId: clio.id, status: 'open' },
		});
		expect(open).toMatchObject([
			{ title: 'Car insurance', dueDate: '2027-03-12', lastDoneOn: '2026-10-06' },
		]);
	});

	it('leaves out a renewal notice read as done, and still reads the item', async () => {
		// A model once marked the duty done for a renewal notice, with no day it was done and no
		// new date: nothing says it was done, so it is not.
		k.llm.respond(understood([mention('records.dutyDone', { target: 'car insurance' })]));
		await read('Your car insurance is due for renewal on 1 November. Renew before then.');
		expect(await drafts()).toHaveLength(0);
		const [item] = (await k.route('inbox.listItems').call({
			query: { limit: 5 },
			actor: admin.actor,
		})) as { status: string; proposals: number; skipped: number }[];
		expect(item).toMatchObject({ status: 'extracted', proposals: 0, skipped: 1 });
	});

	it('finds the vehicle of a service entry too', async () => {
		k.llm.respond(
			understood([
				mention('vehicles.log', {
					about: 'Clio',
					title: 'Yağ değişimi',
					variant: 'service',
					date: { text: '1 Ekim 2026', day: 1, month: 10, year: 2026 },
				}),
			]),
		);
		await read('Clio servis faturası 1 Ekim 2026, yağ değişimi');
		const [draft] = await drafts();
		expect(draft?.input).toMatchObject({ vehicleId: clio.id, doneOn: '2026-10-01' });
	});
});
