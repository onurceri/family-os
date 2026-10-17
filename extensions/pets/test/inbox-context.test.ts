import inbox from '@famos/ext-inbox/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, mention, type TestKernel, understood } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pets from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let mia: { id: string };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [records, pets, inbox] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, formatLocale: 'tr-TR' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin', 'Ayşe');
	const r = await k.runner.invoke<{ id: string }>(
		'pets.addPet',
		{
			name: 'Mia',
			species: 'cat',
			breed: 'Tekir',
			chipNumber: 'SECRETCHIP',
			notes: 'private note',
			obligations: [{ preset: 'rabies', title: 'Rabies', dueDate: '2026-10-20' }],
		},
		admin.actor,
	);
	if (r.status !== 'applied') throw new Error('expected applied');
	mia = r.output;
});
afterEach(() => k.close());

const read = async (text: string) => {
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
	JSON.stringify(k.llm.calls.map(({ system, prompt, areas }) => ({ system, prompt, areas })));
const obligations = () =>
	k.route('records.listObligations').call({ query: { recordId: mia.id, status: 'open' } });

describe('pets in the prompt', () => {
	it('lists pets and their duties by name, without ids, chip number or notes', async () => {
		k.llm.respond(understood());
		await read('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('- Mia (cat, Tekir)');
		expect(system).toContain('- Rabies (Mia) (due 2026-10-20, every year)');
		expect(system).toContain('### pets.treatment');
		expect(seenByModel()).not.toMatch(
			/pet_[0-9a-f]{8}|obligation_[0-9a-f]{8}|pet:1|SECRETCHIP|private note/,
		);
	});

	it('leaves a locked area out: no pets, no duties, no treatment kind', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'pets', access: 'off' },
			admin.actor,
		);
		k.llm.respond(understood());
		await read('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).not.toMatch(/- Mia|Rabies \(Mia|pets\.treatment/);
		expect(k.llm.calls[0]?.areas).not.toContain('pets');
	});
});

describe('a vet card', () => {
	it('becomes a treatment draft that completes the rabies duty when approved', async () => {
		k.llm.respond(
			understood([
				mention('pets.treatment', {
					about: 'Mia',
					title: 'Nobivac Rabies',
					variant: 'vaccination',
					date: { text: '05.10.2026', numeric: '05.10.2026' },
					endDate: { text: '05.10.2027', numeric: '05.10.2027' },
					target: 'Rabies',
					place: 'Pati Klinik',
					notes: 'Seri A123',
				}),
			]),
		);
		await read(
			'Pati Klinik aşı kartı: Mia, Nobivac Rabies, seri A123, 05.10.2026. Sonraki 05.10.2027.',
		);
		const [draft] = await drafts();
		expect(draft?.actionId).toBe('pets.addTreatment');
		expect(draft?.input).toMatchObject({
			petId: mia.id,
			givenOn: '2026-10-05',
			nextDueDate: '2027-10-05',
		});
		expect(String(draft?.input.obligationId)).toMatch(/^obligation_/);
		// Nothing changed before a person approves.
		expect(await obligations()).toMatchObject([{ dueDate: '2026-10-20' }]);

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		expect(await obligations()).toMatchObject([
			{ title: 'Rabies', dueDate: '2027-10-05', lastDoneOn: '2026-10-05' },
		]);
		expect(await k.route('pets.listTreatments').call({ params: { petId: mia.id } })).toMatchObject([
			{ product: 'Nobivac Rabies', vet: 'Pati Klinik' },
		]);
	});

	it('leaves out a treatment for a pet it does not have, and says so', async () => {
		k.llm.respond(
			understood([
				mention('pets.treatment', {
					about: 'Boncuk',
					title: 'Nobivac Rabies',
					variant: 'vaccination',
					date: { text: '05.10.2026', numeric: '05.10.2026' },
				}),
			]),
		);
		await read('Boncuk, Nobivac Rabies, 05.10.2026');
		expect(await drafts()).toHaveLength(0);
		const [item] = (await k
			.route('inbox.listItems')
			.call({ query: { limit: 1 }, actor: admin.actor })) as { skips: unknown[] }[];
		expect(item?.skips).toEqual([{ reason: 'unknown', subject: 'Nobivac Rabies' }]);
	});
});
