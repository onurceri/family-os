import { AiContextSchema, type Mention, type MentionRecord } from '@famos/sdk';
import { resolveMentions, SHARE_AI, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Obligation } from '../src/contract/index.ts';
import { applied, CAR, createKernel, OTHER_CAR, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;
let insurance: Obligation;
let vanInsurance: Obligation;

const vehicle = (id: string, label: string): MentionRecord => ({
	kind: 'vehicle',
	id,
	label,
	url: `/vehicles/${id}`,
});
const VEHICLES = [vehicle(CAR, 'Family car'), vehicle(OTHER_CAR, 'Van')];

const add = (record: string, name: string, input: Record<string, unknown>) =>
	applied<Obligation>(
		k,
		'records.addObligation',
		{
			recordId: record,
			recordKind: 'vehicle',
			recordName: name,
			recordUrl: `/vehicles/${record}`,
			title: 'Car insurance',
			dueDate: '2026-10-20',
			every: { years: 1 },
			...input,
		},
		admin.actor,
	);

/** The household records as a reading lists them: the vehicles, and the duties records shows the AI. */
async function listed(): Promise<MentionRecord[]> {
	const result = await k.runner.invoke('records.aiContext', {}, SHARE_AI);
	if (result.status !== 'applied') throw new Error('expected the context');
	const context = AiContextSchema.parse(result.output);
	return [
		...VEHICLES,
		...context.items.map((i) => ({ kind: context.kind, id: i.id, label: i.label })),
	];
}

const done = (m: Omit<Mention, 'kind'>) => ({ kind: 'records.dutyDone', ...m });
const duty = (m: Omit<Mention, 'kind'>) => ({ kind: 'records.duty', ...m });

beforeEach(async () => {
	({ k } = await createKernel());
	admin = await person(k, 'admin', 'Mara');
	insurance = await add(CAR, 'Family car', {});
	vanInsurance = await add(OTHER_CAR, 'Van', { dueDate: '2026-12-01' });
});
afterEach(() => k.close());

describe('news that a duty was done', () => {
	it('turns "car insurance renewed, new cover to 19 October 2027" into a completion that moves the date', async () => {
		const text =
			'Thank you, your car insurance for the family car has been renewed. New period of cover: 20 October 2026 to 19 October 2027.';
		const [out] = await resolveMentions(
			k,
			'records.dutyDone',
			[
				done({
					target: 'Car insurance',
					about: 'Family car',
					date: { text: '20 October 2026', day: 20, month: 10, year: 2026 },
					endDate: { text: '19 October 2027', day: 19, month: 10, year: 2027 },
				}),
			],
			{ text, records: await listed() },
		);
		expect(out).toEqual({
			propose: {
				actionId: 'records.completeObligation',
				input: {
					id: insurance.id,
					dueDate: '2026-10-20',
					label: 'Car insurance (Family car)',
					doneOn: '2026-10-20',
					nextDueDate: '2027-10-19',
				},
				subject: 'Car insurance',
				targetTitle: 'Car insurance',
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		const drafted = await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI);
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(drafted.draftId, admin.actor);
		const open = await k
			.route('records.listObligations')
			.call({ query: { recordId: CAR, status: 'open' } });
		expect(open).toMatchObject([{ dueDate: '2027-10-19', lastDoneOn: '2026-10-20' }]);
	});

	it('refuses a renewal notice read as done: no day it was done, or the date it already has', async () => {
		// Real model output for "your car insurance is due for renewal … ends on 20 October": the
		// duty marked done with nothing that says it was.
		const text =
			'Your car insurance for the family car ends on 20 October. Renew online before then to stay covered.';
		const out = await resolveMentions(
			k,
			'records.dutyDone',
			[
				done({ target: 'Car insurance', about: 'Family car' }),
				done({
					target: 'Car insurance',
					about: 'Family car',
					endDate: { text: '20 October', day: 20, month: 10 },
				}),
			],
			{ text, records: await listed() },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'incomplete', subject: 'Car insurance', from: [0] } },
			{ refuse: { reason: 'already', subject: 'Car insurance', from: [1] } },
		]);
	});

	it('picks the record the message names when two duties share a title, and says when it cannot', async () => {
		const records = await listed();
		const mention = done({ target: 'Car insurance', date: { text: 'today', inDays: 0 } });
		const [van] = await resolveMentions(k, 'records.dutyDone', [mention], {
			text: 'Paid the car insurance for the Van today',
			records,
		});
		expect(van).toMatchObject({
			propose: { input: { id: vanInsurance.id, doneOn: '2026-10-06' } },
		});
		const [either] = await resolveMentions(k, 'records.dutyDone', [mention], {
			text: 'Paid the car insurance today',
			records,
		});
		expect(either).toEqual({
			refuse: {
				reason: 'ambiguous',
				subject: 'Car insurance (Car insurance Family car, Car insurance Van)',
				from: [0],
			},
		});
	});

	it('knows only the duties the reading listed, and nothing it was not told about', async () => {
		// The van's duties are left out, as a locked area leaves them out.
		const records = (await listed()).filter((r) => r.id !== vanInsurance.id);
		const out = await resolveMentions(
			k,
			'records.dutyDone',
			[
				done({ target: 'Car insurance', about: 'Van', date: { text: 'today', inDays: 0 } }),
				done({ target: 'Dentist checkup', date: { text: 'today', inDays: 0 } }),
			],
			{ text: 'Van insurance paid today, and the dentist checkup is done', records },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'unknown', subject: 'Car insurance', from: [0] } },
			{ refuse: { reason: 'unknown', subject: 'Dentist checkup', from: [1] } },
		]);
	});

	it('leaves out a next date before the day it was done, and asks to check', async () => {
		const [out] = await resolveMentions(
			k,
			'records.dutyDone',
			[
				done({
					target: 'Car insurance',
					about: 'Family car',
					date: { text: '5 October', day: 5, month: 10 },
					endDate: { text: '1 October 2026', day: 1, month: 10, year: 2026 },
				}),
			],
			{
				text: 'Family car insurance paid on 5 October, cover until 1 October 2026',
				records: await listed(),
			},
		);
		expect(out).toMatchObject({
			propose: { input: { doneOn: '2026-10-05' }, uncertain: ['doneOn'] },
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		expect(out.propose.input).not.toHaveProperty('nextDueDate');
	});
});

describe('a new duty', () => {
	it('adds a duty that is not listed to the record the message names', async () => {
		const [out] = await resolveMentions(
			k,
			'records.duty',
			[
				duty({
					title: 'Vehicle inspection',
					about: 'Van',
					variant: 'due',
					date: { text: '15 January', day: 15, month: 1 },
					repeat: { every: 'year', interval: 2 },
				}),
			],
			{
				text: 'The van must pass its inspection by 15 January, and every two years after that.',
				records: await listed(),
			},
		);
		expect(out).toEqual({
			propose: {
				actionId: 'records.addObligation',
				input: {
					recordId: OTHER_CAR,
					recordKind: 'vehicle',
					recordName: 'Van',
					recordUrl: `/vehicles/${OTHER_CAR}`,
					title: 'Vehicle inspection',
					dueDate: '2027-01-15',
					every: { years: 2 },
				},
				subject: 'Vehicle inspection',
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		const drafted = await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI);
		expect(drafted.status).toBe('drafted');
	});

	it('refuses a reminder of a listed duty read as a new one', async () => {
		const [out] = await resolveMentions(
			k,
			'records.duty',
			[
				duty({
					title: 'Car insurance renewal',
					about: 'Family car',
					date: { text: '20 October', day: 20, month: 10 },
				}),
			],
			{
				text: 'Reminder: the family car insurance is due for renewal on 20 October',
				records: await listed(),
			},
		);
		expect(out).toEqual({
			refuse: { reason: 'already', subject: 'Car insurance renewal', from: [0] },
		});
	});

	it('needs a listed record, a title and a day', async () => {
		const records = await listed();
		const out = await resolveMentions(
			k,
			'records.duty',
			[
				duty({
					title: 'Boat licence',
					about: 'Boat',
					date: { text: '1 December', day: 1, month: 12 },
				}),
				duty({ title: 'Parking permit', date: { text: '1 December', day: 1, month: 12 } }),
				duty({ title: 'Road tax', about: 'Van' }),
				duty({ about: 'Van', date: { text: '1 December', day: 1, month: 12 } }),
			],
			{ text: 'Boat licence, parking permit and road tax are due on 1 December', records },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'unknown', subject: 'Boat licence', from: [0] } },
			{ refuse: { reason: 'ambiguous', subject: 'Parking permit', from: [1] } },
			{ refuse: { reason: 'incomplete', subject: 'Road tax', from: [2] } },
			{ refuse: { reason: 'incomplete', subject: 'Van', from: [3] } },
		]);
	});

	it('marks a date that only passes, and a repeat a duty cannot keep, and a guessed record', async () => {
		const [ends, weekly] = await resolveMentions(
			k,
			'records.duty',
			[
				duty({
					title: 'Tyre warranty ends',
					about: 'Family car',
					variant: 'ends',
					date: { text: '2028-01-31', numeric: '2028-01-31' },
					repeat: { every: 'year' },
				}),
				duty({
					title: 'Tyre pressure check',
					about: 'Family car',
					date: { text: 'Friday', weekday: 5 },
					repeat: { every: 'week' },
				}),
			],
			// The message says "the car"; the model chose the listed name.
			{
				text: 'Tyres: warranty to 2028-01-31, check the pressure every Friday',
				records: await listed(),
			},
		);
		expect(ends).toMatchObject({
			propose: {
				input: { recordId: CAR, dueDate: '2028-01-31', lapses: true },
				uncertain: ['recordId'],
			},
		});
		if (!ends || !('propose' in ends)) throw new Error('expected a suggestion');
		expect(ends.propose.input).not.toHaveProperty('every');
		expect(weekly).toMatchObject({
			propose: { input: { dueDate: '2026-10-09' }, uncertain: ['recordId', 'dueDate', 'every'] },
		});
	});

	it('gives it to the person the message names', async () => {
		const tom = await person(k, 'member', 'Tom');
		const [out] = await resolveMentions(
			k,
			'records.duty',
			[
				duty({
					title: 'Vehicle inspection',
					about: 'Van',
					people: ['Tom'],
					date: { text: '15 January', day: 15, month: 1 },
				}),
			],
			{ text: 'Tom takes the van to its inspection by 15 January', records: await listed() },
		);
		expect(out).toMatchObject({ propose: { input: { assigneeId: tom.id } } });
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		expect(out.propose.uncertain).toBeUndefined();
	});
});
