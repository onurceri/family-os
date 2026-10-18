import type { Actor, DigestOutput, MemberId } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernel, type Person, person } from './support.ts';

// The clock stands at Tuesday 6 October 2026.
const PET = 'pet_00000000-0000-7000-8000-000000000001';
const CAR = 'vehicle_00000000-0000-7000-8000-000000000001';
const SPAN = { from: '2026-10-06', to: '2026-10-12' };

let k: TestKernel;
let mara: Person;

beforeEach(async () => {
	k = await createKernel();
	mara = await person(k, 'admin', 'Mara');
	await k.runner.invoke(
		'records.addObligation',
		{
			recordId: PET,
			recordKind: 'pet',
			recordName: 'Rex',
			title: 'Rabies vaccination',
			dueDate: '2026-10-08',
			audience: 'pets.view',
			notes: 'Bring the passport',
		},
		mara.actor,
	);
	await k.runner.invoke(
		'records.addObligation',
		{
			recordId: CAR,
			recordKind: 'vehicle',
			recordName: 'Car',
			title: 'Insurance',
			dueDate: '2026-10-09',
		},
		mara.actor,
	);
});
afterEach(() => k.close());

const ai = (local?: boolean): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: mara.id as MemberId,
	roleId: 'admin',
	...(local && { local: true }),
});
const digest = async (id: string, actor: Actor = ai(), input: object = SPAN) => {
	const result = await k.runner.invoke<DigestOutput>(id, input, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};
const area = (access: 'off' | 'local' | 'any') =>
	k.runner.invoke('core.setAiAreaAccess', { extensionId: 'pets', access }, mara.actor);

describe('pets.digest', () => {
	it('holds only the pets’ duties, with the pet and the notes', async () => {
		const out = await digest('pets.digest');
		expect(out.items).toEqual([
			expect.objectContaining({
				kind: 'duty',
				title: 'Rabies vaccination',
				date: '2026-10-08',
				notes: 'Bring the passport',
				extra: expect.objectContaining({ record: 'Rex', recordId: PET }),
			}),
		]);
		const later = await digest('pets.digest', ai(), { from: '2026-10-10', to: '2026-10-12' });
		expect(later.items).toEqual([]);
	});

	it('gives nothing to an AI when the pets are off for it, and records hides their duties', async () => {
		await area('off');
		await expect(k.runner.invoke('pets.digest', SPAN, ai())).rejects.toMatchObject({
			code: 'forbidden',
		});
		const all = await digest('records.digest');
		expect(all.items.map((i) => i.title)).toEqual(['Insurance']);
		expect(all.hidden).toBe(1);
		// A person still sees both.
		expect((await digest('records.digest', mara.actor)).items).toHaveLength(2);
	});

	it('gives a local-only area’s duties only to a local model', async () => {
		await area('local');
		await expect(k.runner.invoke('pets.digest', SPAN, ai())).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect((await digest('records.digest')).hidden).toBe(1);
		expect((await digest('pets.digest', ai(true))).items).toHaveLength(1);
		const local = await digest('records.digest', ai(true));
		expect(local.items).toHaveLength(2);
		expect(local.hidden).toBeUndefined();
	});
});

describe('pets.digest links', () => {
	it("opens the pet's page from the duty a pet was added with", async () => {
		const added = await k.runner.invoke<{ id: string }>(
			'pets.addPet',
			{
				name: 'Pamuk',
				species: 'cat',
				obligations: [{ preset: 'rabies', title: 'Rabies', dueDate: '2026-10-09' }],
			},
			mara.actor,
		);
		if (added.status !== 'applied') throw new Error('expected a pet');
		const out = await digest('pets.digest');
		expect(out.items.find((i) => i.title === 'Rabies')?.href).toBe(`/pets/${added.output.id}`);
		// A duty added without a page for its record stays plain.
		expect(out.items.find((i) => i.title === 'Rabies vaccination')?.href).toBeUndefined();
	});
});
