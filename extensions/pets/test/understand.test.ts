import { AiContextSchema, type Mention, type MentionRecord, systemActor } from '@famos/sdk';
import { resolveMentions, SHARE_AI, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;
let mia: { id: string };
let rabies: { id: string };

const treatment = (m: Omit<Mention, 'kind'>) => ({ kind: 'pets.treatment', ...m });

/** What a reading lists to the model: the pets and the duties records shows the AI. */
async function listed(): Promise<MentionRecord[]> {
	const out: MentionRecord[] = [];
	for (const id of ['pets.aiContext', 'records.aiContext']) {
		const result = await k.runner.invoke(id, {}, SHARE_AI);
		if (result.status !== 'applied') throw new Error('expected the context');
		const context = AiContextSchema.parse(result.output);
		out.push(...context.items.map((i) => ({ kind: context.kind, id: i.id, label: i.label })));
	}
	return out;
}

beforeEach(async () => {
	k = await createKernel();
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ formatLocale: 'en-GB', hourCycle: 'h23' },
		systemActor('test'),
	);
	admin = await person(k, 'admin', 'Mara');
	mia = await applied(
		k,
		'pets.addPet',
		{
			name: 'Mia',
			species: 'cat',
			obligations: [{ preset: 'rabies', title: 'Rabies', dueDate: '2026-10-20' }],
		},
		admin.actor,
	);
	await applied(k, 'pets.addPet', { name: 'Max', species: 'dog' }, admin.actor);
	const [duty] = (await k
		.route('records.listObligations')
		.call({ query: { recordId: mia.id, status: 'open' } })) as { id: string }[];
	if (!duty) throw new Error('expected the rabies duty');
	rabies = duty;
});
afterEach(() => k.close());

describe('a treatment read from a message', () => {
	it('turns a vet card into a treatment that completes the rabies duty when approved', async () => {
		const text =
			'Vaccination card: Mia, Nobivac Rabies, batch A123, 05.10.2026, Riverside Vet. Next due 05.10.2027.';
		const [out] = await resolveMentions(
			k,
			'pets.treatment',
			[
				treatment({
					about: 'Mia',
					title: 'Nobivac Rabies',
					variant: 'vaccination',
					date: { text: '05.10.2026', numeric: '05.10.2026' },
					endDate: { text: '05.10.2027', numeric: '05.10.2027' },
					target: 'Rabies',
					place: 'Riverside Vet',
					notes: 'Batch A123',
				}),
			],
			{ text, records: await listed() },
		);
		expect(out).toEqual({
			propose: {
				actionId: 'pets.addTreatment',
				input: {
					petId: mia.id,
					petName: 'Mia',
					kind: 'vaccination',
					givenOn: '2026-10-05',
					product: 'Nobivac Rabies',
					vet: 'Riverside Vet',
					notes: 'Batch A123',
					obligationId: rabies.id,
					nextDueDate: '2027-10-05',
				},
				subject: 'Nobivac Rabies',
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		const drafted = await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI);
		if (drafted.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(drafted.draftId, admin.actor);
		expect(
			await k
				.route('records.listObligations')
				.call({ query: { recordId: mia.id, status: 'open' } }),
		).toMatchObject([{ dueDate: '2027-10-05', lastDoneOn: '2026-10-05' }]);
	});

	it('finds the duty from what was given when the model names none, as a guess', async () => {
		const [out] = await resolveMentions(
			k,
			'pets.treatment',
			[
				treatment({
					about: 'Mia',
					title: 'Nobivac Rabies',
					variant: 'vaccination',
					date: { text: 'yesterday', inDays: -1 },
				}),
			],
			{ text: 'Mia had her Nobivac Rabies yesterday', records: await listed() },
		);
		expect(out).toMatchObject({
			propose: {
				input: { obligationId: rabies.id, givenOn: '2026-10-05' },
				uncertain: ['obligationId'],
			},
		});
	});

	it('never completes a duty of another pet', async () => {
		const [out] = await resolveMentions(
			k,
			'pets.treatment',
			[
				treatment({
					about: 'Max',
					title: 'Rabies vaccine',
					variant: 'vaccination',
					target: 'Rabies',
					date: { text: 'today', inDays: 0 },
				}),
			],
			{ text: 'Max got his rabies vaccine today', records: await listed() },
		);
		expect(out).toMatchObject({ propose: { input: { petName: 'Max' } } });
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		expect(out.propose.input).not.toHaveProperty('obligationId');
	});

	it('refuses a pet that is not listed instead of picking another', async () => {
		// The model used to write an invented handle ("pet:9") for a pet it was never told about.
		const out = await resolveMentions(
			k,
			'pets.treatment',
			[
				treatment({ about: 'Rex', title: 'Worm tablet', date: { text: 'today', inDays: 0 } }),
				treatment({ title: 'Flea drops', date: { text: 'today', inDays: 0 } }),
			],
			{
				text: 'Rex had his worm tablet, and flea drops for the cat today',
				records: await listed(),
			},
		);
		expect(out).toEqual([
			{ refuse: { reason: 'unknown', subject: 'Worm tablet', from: [0] } },
			{ refuse: { reason: 'ambiguous', subject: 'Flea drops', from: [1] } },
		]);
	});

	it('marks what it guessed: no day, no kind', async () => {
		const [out] = await resolveMentions(
			k,
			'pets.treatment',
			[treatment({ about: 'Max', title: 'Ear drops' })],
			{ text: 'Max: ear drops', records: await listed() },
		);
		expect(out).toMatchObject({
			propose: {
				input: { givenOn: '2026-10-06', kind: 'other', product: 'Ear drops' },
				uncertain: ['givenOn', 'kind'],
			},
		});
	});

	it('leaves out a treatment that is already in the history', async () => {
		await applied(
			k,
			'pets.addTreatment',
			{ petId: mia.id, kind: 'parasite_internal', givenOn: '2026-10-06', product: 'Worm tablet' },
			admin.actor,
		);
		const [out] = await resolveMentions(
			k,
			'pets.treatment',
			[
				treatment({
					about: 'Mia',
					title: 'Worm tablet',
					variant: 'parasite_internal',
					date: { text: 'today', inDays: 0 },
				}),
			],
			{ text: 'Gave Mia her worm tablet today', records: await listed() },
		);
		expect(out).toEqual({ refuse: { reason: 'already', subject: 'Worm tablet', from: [0] } });
	});
});
