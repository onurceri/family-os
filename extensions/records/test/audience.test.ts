import { defineCapability } from '@famos/sdk';
import { defineTestExtension, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Obligation, RecordDocument } from '../src/contract/index.ts';
import { searchIndex } from '../src/server/search.ts';
import { applied, CAR, createKernel, type Person, person, recordId } from './support.ts';

const petsView = defineCapability({ id: 'pets.view', label: 'pets:cap_view', level: 'view' });
const pets = defineTestExtension({ id: 'pets', capabilities: [petsView], recordIds: ['pet'] });
const PET = recordId('pet');

let k: TestKernel;
let admin: Person;
let owner: Person;
let carOnly: Person;

beforeEach(async () => {
	({ k } = await createKernel({ extensions: [pets] }));
	admin = await person(k, 'admin');
	// May see records but not the pets' area.
	const role = await k.runner.invoke<{ id: string }>(
		'core.createRole',
		{ name: 'No pets', base: 'member', overrides: { 'pets.view': false } },
		admin.actor,
	);
	if (role.status !== 'applied') throw new Error('expected role');
	carOnly = await person(k, role.output.id, 'Car only');
	owner = await person(k, 'member', 'Owner');
});
afterEach(() => k.close());

const addDuty = (input: Record<string, unknown>) =>
	applied<Obligation>(
		k,
		'records.addObligation',
		{
			recordId: CAR,
			recordKind: 'vehicle',
			recordName: 'Golf',
			recordUrl: `/vehicles/${CAR}`,
			title: 'Car insurance',
			dueDate: '2026-10-20',
			...input,
		},
		admin.actor,
	);
const addPetDuty = () =>
	addDuty({
		recordId: PET,
		recordKind: 'pet',
		recordName: 'Pamuk',
		recordUrl: `/pets/${PET}`,
		audience: 'pets.view',
		title: 'Vaccination',
	});

const ITEM = 'inbox_item_00000000-0000-7000-8000-000000000001';
async function paper(recordIdOf: string, recordKind: string, n: number) {
	const key = `inbox/${ITEM}/${n}`;
	await k.ctx.files.put(key, new TextEncoder().encode('vet card'), 'application/pdf');
	await k.ctx.files.grant(key, 'records');
	const [doc] = await applied<RecordDocument[]>(
		k,
		'records.attachDocument',
		{
			recordId: recordIdOf,
			recordKind,
			files: [{ key, name: `card-${n}.pdf`, type: 'application/pdf' }],
		},
		admin.actor,
	);
	return doc as RecordDocument;
}

const call = (operationId: string, request: Record<string, unknown>, who: Person) =>
	k.route(operationId).call({ actor: who.actor, ...request });

describe('a duty belongs to the area it names', () => {
	it('is listed only to those who may see that area', async () => {
		const pet = await addPetDuty();
		await addDuty({});
		const upcoming = (who: Person) =>
			call('records.listUpcoming', { query: { days: 30 } }, who).then((r: Obligation[]) =>
				r.map((o) => o.title),
			);
		expect(await upcoming(carOnly)).toEqual(['Car insurance']);
		expect((await upcoming(owner)).sort()).toEqual(['Car insurance', 'Vaccination']);

		const listed = (who: Person) =>
			call('records.listObligations', { query: { recordId: PET, status: 'open' } }, who);
		expect(await listed(carOnly)).toEqual([]);
		expect(await listed(owner)).toHaveLength(1);

		await applied(k, 'records.completeObligation', { id: pet.id }, admin.actor);
		const history = (who: Person) =>
			call('records.getObligationHistory', { params: { obligationId: pet.id } }, who);
		expect(await history(carOnly)).toEqual([]);
		expect(await history(owner)).toHaveLength(1);
	});
});

describe('a paper belongs to its record’s area', () => {
	it('is hidden from those who may not see the area, and shown to those who may', async () => {
		await addPetDuty();
		const card = await paper(PET, 'pet', 0);
		const list = (who: Person) => call('records.listDocuments', { query: { recordId: PET } }, who);
		const file = (who: Person) =>
			call('records.getDocumentFile', { params: { documentId: card.id } }, who);

		expect(await list(carOnly)).toEqual([]);
		await expect(file(carOnly)).rejects.toMatchObject({ code: 'not_found' });
		expect(await list(owner)).toHaveLength(1);
		expect((await file(owner)).filename).toBe('card-0.pdf');
	});

	it('follows the kind when its record has no duty of its own yet', async () => {
		await addPetDuty();
		const other = recordId('pet', 2);
		const card = await paper(other, 'pet', 1);
		await expect(
			call('records.getDocumentFile', { params: { documentId: card.id } }, carOnly),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('stays open to records.view when no duty names another area', async () => {
		const card = await paper(CAR, 'vehicle', 2);
		expect(
			(await call('records.listDocuments', { query: { recordId: CAR } }, carOnly)).length,
		).toBe(1);
		expect(
			(await call('records.getDocumentFile', { params: { documentId: card.id } }, carOnly))
				.filename,
		).toBe('card-2.pdf');
	});

	it('is searchable under its area, with the record’s name and page', async () => {
		await addPetDuty();
		const card = await paper(PET, 'pet', 3);
		const entry = await searchIndex.kinds['records.paper']?.load(k.ctx, card.id);
		expect(entry).toMatchObject({
			title: 'card-3.pdf',
			text: 'other\nPamuk',
			href: `/pets/${PET}`,
			capability: 'pets.view',
		});
	});

	it('takes the area of a duty added after the paper was filed', async () => {
		const card = await paper(PET, 'pet', 4);
		const before = await searchIndex.kinds['records.paper']?.load(k.ctx, card.id);
		expect(before?.capability).toBe('records.view');
		await addPetDuty();
		const after = await searchIndex.kinds['records.paper']?.load(k.ctx, card.id);
		expect(after).toMatchObject({ capability: 'pets.view', href: `/pets/${PET}` });
	});
});
