import { type Mention, systemActor } from '@famos/sdk';
import { resolveMentions, SHARE_AI, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;
let flat: { id: string };
let washer: { id: string };

const item = (m: Omit<Mention, 'kind'>) => ({ kind: 'home.item', ...m });
const open = (recordId: string) =>
	k.route('records.listObligations').call({ query: { recordId, status: 'open' } });

beforeEach(async () => {
	k = await createKernel();
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ formatLocale: 'en-GB', hourCycle: 'h23' },
		systemActor('test'),
	);
	admin = await person(k, 'admin', 'Mara');
	flat = await applied(k, 'home.addHome', { name: 'Our flat', tenure: 'tenant' }, admin.actor);
	washer = await applied(
		k,
		'home.addItem',
		{
			homeId: flat.id,
			name: 'Washing machine',
			brand: 'Bosch',
			model: 'WAX32',
			purchasedOn: '2025-09-20',
			warrantyUntil: '2027-09-20',
		},
		admin.actor,
	);
});
afterEach(() => k.close());

describe('a thing bought', () => {
	it('turns a receipt into a new thing whose warranty code works out, and that creates the duty', async () => {
		const [out] = await resolveMentions(
			k,
			'home.item',
			[
				item({
					title: 'Fridge',
					lines: ['Samsung', 'RB38'],
					date: { text: '05.10.2026', numeric: '05.10.2026' },
					amount: '24',
				}),
			],
			{ text: 'Receipt: Samsung RB38 fridge, 05.10.2026, 2 years warranty' },
		);
		expect(out).toEqual({
			propose: {
				actionId: 'home.addItem',
				input: {
					homeId: flat.id,
					homeName: 'Our flat',
					name: 'Fridge',
					brand: 'Samsung',
					model: 'RB38',
					purchasedOn: '2026-10-05',
					warrantyUntil: '2028-10-05',
				},
				subject: 'Fridge',
				// The only home, though the receipt does not name it.
				uncertain: ['homeId'],
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		const drafted = await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI);
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(drafted.draftId, admin.actor);
		const [fridge] = (await k.route('home.listItems').call({ query: {} })).filter(
			(i: { name: string }) => i.name === 'Fridge',
		);
		expect(await open(fridge.id)).toMatchObject([{ dueDate: '2028-10-05' }]);
	});

	it('leaves out a thing that is already listed, and needs a name and a listed home', async () => {
		await applied(k, 'home.addHome', { name: 'Cabin', tenure: 'owner' }, admin.actor);
		const out = await resolveMentions(
			k,
			'home.item',
			[
				item({ title: 'washing machine', about: 'Our flat', lines: ['Bosch', 'WAX32'] }),
				item({ title: 'Oven', about: 'Beach house' }),
				item({ title: 'Kettle' }),
				item({ lines: ['Bosch'] }),
			],
			{ text: 'Bosch WAX32 washing machine, an oven, a kettle' },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'washing machine', from: [0] } },
			{ refuse: { reason: 'unknown', subject: 'Oven', from: [1] } },
			{ refuse: { reason: 'ambiguous', subject: 'Kettle', from: [2] } },
			{ refuse: { reason: 'incomplete', subject: null, from: [3] } },
		]);
	});
});

describe('news about a listed thing', () => {
	it('turns "warranty extended" into a change of that date alone, which moves the duty', async () => {
		const [out] = await resolveMentions(
			k,
			'home.item',
			[
				item({
					target: 'Washing machine',
					lines: ['Bosch', 'WAX32'],
					endDate: { text: '20.09.2029', numeric: '20.09.2029' },
				}),
			],
			{ text: 'Extended warranty for your Bosch WAX32 washing machine: covered until 20.09.2029' },
		);
		expect(out).toEqual({
			propose: {
				actionId: 'home.updateItem',
				input: { id: washer.id, itemName: 'Washing machine', warrantyUntil: '2029-09-20' },
				subject: 'Washing machine',
				targetTitle: 'Washing machine',
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		const drafted = await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI);
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(drafted.draftId, admin.actor);
		expect(await open(washer.id)).toMatchObject([{ dueDate: '2029-09-20' }]);
	});

	it('counts a warranty length from the day it was bought, and says when nothing is new', async () => {
		const out = await resolveMentions(
			k,
			'home.item',
			[
				item({ target: 'Washing machine', amount: '36' }),
				item({ target: 'Washing machine', endDate: { text: '20.09.2027', numeric: '20.09.2027' } }),
				item({ target: 'Dishwasher', amount: '12' }),
			],
			{
				text: 'Washing machine: 3 years warranty in all, so to 20.09.2027 no more. Dishwasher 1 year',
			},
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'home.updateItem',
					input: { id: washer.id, itemName: 'Washing machine', warrantyUntil: '2028-09-20' },
					subject: 'Washing machine',
					targetTitle: 'Washing machine',
					from: [0],
				},
			},
			{ refuse: { reason: 'already', subject: 'Washing machine', from: [1] } },
			{ refuse: { reason: 'unknown', subject: 'Dishwasher', from: [2] } },
		]);
	});
});
