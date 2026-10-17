import { type Mention, systemActor } from '@famos/sdk';
import { resolveMentions, SHARE_AI, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;
let clio: { id: string };
let golf: { id: string };

const log = (m: Omit<Mention, 'kind'>) => ({ kind: 'vehicles.log', ...m });

beforeEach(async () => {
	k = await createKernel();
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ formatLocale: 'en-GB', hourCycle: 'h23' },
		systemActor('test'),
	);
	admin = await person(k, 'admin', 'Mara');
	clio = await applied(k, 'vehicles.addVehicle', { name: 'Clio', fuel: 'petrol' }, admin.actor);
	golf = await applied(k, 'vehicles.addVehicle', { name: 'Golf', fuel: 'diesel' }, admin.actor);
});
afterEach(() => k.close());

it('is not read while the vehicles area is locked for the AI', async () => {
	await k.runner.invoke(
		'core.setAiAreaAccess',
		{ extensionId: 'vehicles', access: 'off' },
		admin.actor,
	);
	expect(k.ctx.actions.aiKinds().map((kind) => kind.id)).not.toContain('vehicles.log');
	await expect(
		resolveMentions(k, 'vehicles.log', [log({ about: 'Clio', title: 'Oil change' })]),
	).rejects.toMatchObject({ code: 'forbidden' });
});

describe('work done on a vehicle', () => {
	it('turns a service invoice into a log entry of the vehicle it names', async () => {
		const [out] = await resolveMentions(
			k,
			'vehicles.log',
			[
				log({
					about: 'Clio',
					title: 'Oil change',
					variant: 'service',
					date: { text: '1 October 2026', day: 1, month: 10, year: 2026 },
					place: 'City Garage',
					notes: 'Mileage 84,000 km',
				}),
			],
			{ text: 'Invoice, City Garage, 1 October 2026: oil change for the Clio. Mileage 84,000 km.' },
		);
		expect(out).toEqual({
			propose: {
				actionId: 'vehicles.addLog',
				input: {
					vehicleId: clio.id,
					vehicleName: 'Clio',
					kind: 'service',
					doneOn: '2026-10-01',
					place: 'City Garage',
					notes: 'Oil change; Mileage 84,000 km',
				},
				subject: 'Oil change',
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		const drafted = await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI);
		expect(drafted.status).toBe('drafted');
	});

	it('takes the listed name the model chose when the message only says "the car", as a guess', async () => {
		await applied(k, 'vehicles.archiveVehicle', { id: golf.id }, admin.actor);
		const [out] = await resolveMentions(
			k,
			'vehicles.log',
			[
				log({
					about: 'Clio',
					title: 'New tyres',
					variant: 'repair',
					date: { text: 'yesterday', inDays: -1 },
				}),
			],
			{ text: 'Got new tyres on the car yesterday' },
		);
		expect(out).toMatchObject({
			propose: { input: { vehicleId: clio.id, doneOn: '2026-10-05' }, uncertain: ['vehicleId'] },
		});
	});

	it('refuses a vehicle it does not know, and says when it cannot tell which', async () => {
		const out = await resolveMentions(
			k,
			'vehicles.log',
			[
				log({ about: 'Boat', title: 'Engine service', date: { text: 'today', inDays: 0 } }),
				log({ title: 'Car wash', date: { text: 'today', inDays: 0 } }),
				log({ about: 'Golf' }),
			],
			{ text: 'Boat engine service and a car wash today' },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'unknown', subject: 'Engine service', from: [0] } },
			{ refuse: { reason: 'ambiguous', subject: 'Car wash', from: [1] } },
			{ refuse: { reason: 'incomplete', subject: 'Golf', from: [2] } },
		]);
	});

	it('leaves out an entry that is already in the log, and marks a missing day and kind', async () => {
		await applied(
			k,
			'vehicles.addLog',
			{ vehicleId: golf.id, kind: 'service', doneOn: '2026-10-01' },
			admin.actor,
		);
		const out = await resolveMentions(
			k,
			'vehicles.log',
			[
				log({
					about: 'Golf',
					title: 'Service',
					variant: 'service',
					date: { text: '1 October', day: 1, month: 10 },
				}),
				log({ about: 'Golf', title: 'Wipers' }),
			],
			{ text: 'Golf: service on 1 October, and new wipers' },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'Service', from: [0] } },
			{
				propose: {
					actionId: 'vehicles.addLog',
					input: {
						vehicleId: golf.id,
						vehicleName: 'Golf',
						kind: 'service',
						doneOn: '2026-10-06',
						notes: 'Wipers',
					},
					subject: 'Wipers',
					uncertain: ['doneOn', 'kind'],
					from: [1],
				},
			},
		]);
	});
});
