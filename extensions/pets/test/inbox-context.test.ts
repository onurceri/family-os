import inbox from '@famos/ext-inbox/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pets from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let mia: { id: string };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [records, pets, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
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
	it('lists pets and their duties by handle, without ids, chip number or notes', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('- Mia (pet:1): cat, Tekir');
		expect(system).toContain('- Rabies (Mia) (obligation:1): due 2026-10-20, every year');
		expect(seenByModel()).not.toMatch(
			/pet_[0-9a-f]{8}|obligation_[0-9a-f]{8}|SECRETCHIP|private note/,
		);
	});

	it('leaves a locked area out: no pets, no duties, no treatment action', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'pets', access: 'off' },
			admin.actor,
		);
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('Hello');
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).not.toMatch(/Mia|\(pet:|Rabies \(|pets\.addTreatment/);
		expect(k.llm.calls[0]?.areas).not.toContain('pets');
	});
});

describe('a vet card', () => {
	it('becomes a treatment draft that completes the rabies duty when approved', async () => {
		k.llm.respond({
			summary: 'Kuduz aşısı yapıldı',
			proposals: [
				{
					action: 'pets.addTreatment',
					input: {
						petId: 'pet:1',
						kind: 'vaccination',
						givenOn: '2026-10-05',
						product: 'Nobivac Rabies',
						batch: 'A123',
						vet: 'Pati Klinik',
						obligationId: 'obligation:1',
						nextDueDate: '2027-10-05',
						petName: 'Mia',
					},
					dateText: '05.10.2026',
					confidence: 0.9,
				},
			],
		});
		await read(
			'Pati Klinik aşı kartı: Mia, Nobivac Rabies, seri A123, 05.10.2026. Sonraki 05.10.2027.',
		);
		const [draft] = await drafts();
		expect(draft?.actionId).toBe('pets.addTreatment');
		expect(draft?.input).toMatchObject({ petId: mia.id, givenOn: '2026-10-05' });
		expect(String(draft?.input.obligationId)).toMatch(/^obligation_/);
		// Nothing changed before a person approves.
		expect(await obligations()).toMatchObject([{ dueDate: '2026-10-20' }]);

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		expect(await obligations()).toMatchObject([
			{ title: 'Rabies', dueDate: '2027-10-05', lastDoneOn: '2026-10-05' },
		]);
		expect(await k.route('pets.listTreatments').call({ params: { petId: mia.id } })).toMatchObject([
			{ product: 'Nobivac Rabies', batch: 'A123', vet: 'Pati Klinik' },
		]);
	});

	it('drops a treatment for a pet it never listed', async () => {
		k.llm.respond({
			summary: 'x',
			proposals: [
				{
					action: 'pets.addTreatment',
					input: { petId: 'pet:9', givenOn: '2026-10-05' },
					confidence: 1,
				},
				{
					action: 'pets.addTreatment',
					input: { petId: 'pet_00000000-0000-7000-8000-000000000042', givenOn: '2026-10-05' },
					confidence: 1,
				},
			],
		});
		await read('Bir kart');
		expect(await drafts()).toHaveLength(0);
	});
});
