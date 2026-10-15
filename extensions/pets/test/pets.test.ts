import type { Obligation } from '@famos/ext-records/contract';
import { FamosError } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	PET_PRESETS,
	type Pet,
	type PetTreatment,
	PRESET_IDS,
	petUrl,
	presetsFor,
} from '../src/contract/index.ts';
import { AI, applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
});
afterEach(() => k.close());

const addPet = (input: Record<string, unknown> = {}, actor = admin.actor) =>
	applied<Pet>(
		k,
		'pets.addPet',
		{ name: 'Pamuk', species: 'cat', breed: 'Tekir', ...input },
		actor,
	);
const pets = (): Promise<Pet[]> => k.route('pets.listPets').call();
const obligations = (recordId: string, status = 'open'): Promise<Obligation[]> =>
	k.route('records.listObligations').call({ query: { recordId, status } });
const treatments = (petId: string): Promise<PetTreatment[]> =>
	k.route('pets.listTreatments').call({ params: { petId } });
const withRabies = () =>
	addPet({ obligations: [{ preset: 'rabies', title: 'Rabies', dueDate: '2026-10-20' }] });

describe('pets', () => {
	it('adds, lists, reads and changes a pet', async () => {
		const cat = await addPet({
			sex: 'female',
			birthDate: '2022-04-01',
			chipNumber: '941000012345678',
			vet: 'Pati Klinik, 0212 555 00 00',
			notes: 'Afraid of the carrier',
		});
		expect(cat).toMatchObject({
			name: 'Pamuk',
			species: 'cat',
			sex: 'female',
			birthDate: '2022-04-01',
		});
		expect(cat.id).toMatch(/^pet_/);
		expect(await pets()).toHaveLength(1);
		expect(await k.route('pets.getPet').call({ params: { petId: cat.id } })).toMatchObject({
			chipNumber: '941000012345678',
			vet: 'Pati Klinik, 0212 555 00 00',
			memberIds: [],
		});

		const changed = await applied<Pet>(
			k,
			'pets.updatePet',
			{ id: cat.id, pet: { name: 'Pamuk', species: 'cat', memberIds: [admin.id] } },
			admin.actor,
		);
		expect(changed).toMatchObject({ memberIds: [admin.id], breed: '' });
		// A field left out is cleared: the form always sends the whole pet.
		expect(changed.chipNumber).toBeNull();
	});

	it('refuses an unknown member, a species that does not exist, a bad date and a missing name', async () => {
		const fail = (input: Record<string, unknown>) =>
			addPet(input).then(
				() => null,
				(e: unknown) => e,
			);
		expect(
			await fail({ memberIds: ['member_00000000-0000-7000-8000-000000000999'] }),
		).toBeInstanceOf(FamosError);
		expect(await fail({ species: 'dragon' })).toBeInstanceOf(FamosError);
		expect(await fail({ birthDate: '2022-13-01' })).toBeInstanceOf(FamosError);
		expect(await fail({ name: '  ' })).toBeInstanceOf(FamosError);
		expect(await pets()).toHaveLength(0);
	});

	it('answers not found for an unknown pet', async () => {
		await expect(
			k
				.route('pets.getPet')
				.call({ params: { petId: 'pet_00000000-0000-7000-8000-000000000001' } }),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('what usually needs doing', () => {
	it('creates the picked obligations with the preset’s repeat and lead time', async () => {
		const cat = await addPet({
			obligations: [
				{ preset: 'rabies', title: 'Rabies vaccination', dueDate: '2026-11-20' },
				{ preset: 'parasite_internal', title: 'Worming', dueDate: '2026-12-01' },
				{ preset: 'parasite_external', title: 'Flea and tick', dueDate: '2026-10-25' },
			],
		});
		const list = await obligations(cat.id);
		expect(list.map((o) => o.title)).toEqual(['Flea and tick', 'Rabies vaccination', 'Worming']);
		expect(list).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'rabies',
					dueDate: '2026-11-20',
					every: { years: 1 },
					leadDays: 30,
					audience: 'pets.view',
					recordKind: 'pet',
					recordName: 'Pamuk',
					recordUrl: petUrl(cat.id),
				}),
				expect.objectContaining({ kind: 'parasite_internal', every: { months: 3 } }),
				expect.objectContaining({ kind: 'parasite_external', every: { months: 1 } }),
			]),
		);
	});

	it('takes the interval and lead time the person chose', async () => {
		const cat = await addPet({
			obligations: [
				{
					preset: 'core_vaccine',
					title: 'Core booster',
					dueDate: '2026-11-20',
					every: { years: 3 },
					leadDays: 10,
				},
				{ preset: 'checkup', title: 'Check-up', dueDate: '2026-11-20', every: null },
			],
		});
		const byKind = Object.fromEntries((await obligations(cat.id)).map((o) => [o.kind, o]));
		expect(byKind.core_vaccine).toMatchObject({ every: { years: 3 }, leadDays: 10 });
		expect(byKind.checkup).toMatchObject({ every: null, leadDays: 21 });
	});

	it('refuses a preset that does not exist and adds nothing', async () => {
		await expect(
			addPet({ obligations: [{ preset: 'flying', title: 'x', dueDate: '2026-11-20' }] }),
		).rejects.toBeInstanceOf(FamosError);
		expect(await pets()).toHaveLength(0);
	});

	it('declares every preset with a title key and a repeat, and suggests by species', () => {
		expect(PET_PRESETS.map((p) => p.id)).toEqual(PRESET_IDS);
		for (const preset of PET_PRESETS) {
			expect(preset.titleKey).toMatch(/^pets:preset_/);
			expect(preset.every).toBeDefined();
		}
		expect(presetsFor('cat').map((p) => p.id)).toContain('rabies');
		expect(presetsFor('fish').map((p) => p.id)).toEqual(['checkup']);
	});
});

describe('treatments', () => {
	it('records a treatment and lists the newest first', async () => {
		const cat = await addPet();
		const add = (input: Record<string, unknown>) =>
			applied<PetTreatment>(k, 'pets.addTreatment', { petId: cat.id, ...input }, admin.actor);
		await add({
			givenOn: '2026-03-01',
			product: 'Nobivac Rabies',
			batch: 'A123',
			vet: 'Pati Klinik',
		});
		const worm = await add({
			kind: 'parasite_internal',
			givenOn: '2026-08-15',
			product: 'Drontal',
		});
		expect((await treatments(cat.id)).map((t) => [t.kind, t.givenOn])).toEqual([
			['parasite_internal', '2026-08-15'],
			['vaccination', '2026-03-01'],
		]);
		expect((await treatments(cat.id))[1]).toMatchObject({
			product: 'Nobivac Rabies',
			batch: 'A123',
			createdBy: admin.id,
		});
		await applied(k, 'pets.removeTreatment', { id: worm.id }, admin.actor);
		expect(await treatments(cat.id)).toHaveLength(1);
		await expect(
			applied(k, 'pets.removeTreatment', { id: worm.id }, admin.actor),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('completes the matching duty on the day it was given and moves its date', async () => {
		const cat = await withRabies();
		const [rabies] = await obligations(cat.id);
		await applied(
			k,
			'pets.addTreatment',
			{ petId: cat.id, givenOn: '2026-10-05', product: 'Nobivac', obligationId: rabies?.id },
			admin.actor,
		);
		expect(await obligations(cat.id)).toMatchObject([
			{ title: 'Rabies', dueDate: '2027-10-20', lastDoneOn: '2026-10-05' },
		]);
		expect(await treatments(cat.id)).toHaveLength(1);
	});

	it('takes the next date from the card when it says so', async () => {
		const cat = await withRabies();
		const [rabies] = await obligations(cat.id);
		await applied(
			k,
			'pets.addTreatment',
			{
				petId: cat.id,
				givenOn: '2026-10-05',
				obligationId: rabies?.id,
				nextDueDate: '2028-10-05',
			},
			admin.actor,
		);
		expect((await obligations(cat.id))[0]?.dueDate).toBe('2028-10-05');
	});

	it('refuses a duty of another pet and records nothing', async () => {
		const cat = await withRabies();
		const dog = await addPet({ name: 'Karabaş', species: 'dog' });
		const [rabies] = await obligations(cat.id);
		await expect(
			applied(
				k,
				'pets.addTreatment',
				{ petId: dog.id, givenOn: '2026-10-05', obligationId: rabies?.id },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(await treatments(dog.id)).toHaveLength(0);
		expect((await obligations(cat.id))[0]?.dueDate).toBe('2026-10-20');
	});

	it('refuses an entry for an unknown or archived pet, and a bad date', async () => {
		const cat = await addPet();
		const add = (petId: string, givenOn = '2026-03-01') =>
			applied(k, 'pets.addTreatment', { petId, givenOn }, admin.actor);
		await expect(add('pet_00000000-0000-7000-8000-000000000001')).rejects.toMatchObject({
			code: 'not_found',
		});
		await expect(add(cat.id, '2026-13-01')).rejects.toBeInstanceOf(FamosError);
		await applied(k, 'pets.archivePet', { id: cat.id }, admin.actor);
		await expect(add(cat.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('keeps the reviewer-only pet name out of storage', async () => {
		const cat = await addPet();
		const t = await applied<PetTreatment & { petName?: string }>(
			k,
			'pets.addTreatment',
			{ petId: cat.id, givenOn: '2026-03-01', petName: 'Pamuk' },
			admin.actor,
		);
		expect(t).not.toHaveProperty('petName');
	});
});

describe('a treatment sent for approval', () => {
	it('names the pet it is for, though the form sends only its id', async () => {
		const pet = await addPet({ name: 'Biscuit', species: 'dog' });
		const ivy = await person(k, 'supervised', 'Ivy');
		const result = await k.runner.invoke(
			'pets.addTreatment',
			{ petId: pet.id, kind: 'vaccination', givenOn: '2026-09-02', product: 'Rabies' },
			ivy.actor,
		);
		expect(result).toMatchObject({ status: 'drafted', subject: 'Biscuit' });
	});
});

describe('records follow the pet', () => {
	it('renames the record when the name changes', async () => {
		const cat = await withRabies();
		await applied(
			k,
			'pets.updatePet',
			{ id: cat.id, pet: { name: 'Pamuk 2', species: 'cat' } },
			admin.actor,
		);
		expect((await obligations(cat.id))[0]).toMatchObject({
			recordName: 'Pamuk 2',
			recordUrl: petUrl(cat.id),
		});
	});

	it('archives the pet with its obligations, and hides it everywhere', async () => {
		const cat = await withRabies();
		await addPet({ name: 'Karabaş', species: 'dog' });
		await applied(k, 'pets.archivePet', { id: cat.id }, admin.actor);
		expect((await pets()).map((p) => p.name)).toEqual(['Karabaş']);
		expect(await obligations(cat.id)).toHaveLength(0);
		expect(await obligations(cat.id, 'archived')).toHaveLength(1);
		await expect(k.route('pets.getPet').call({ params: { petId: cat.id } })).rejects.toMatchObject({
			code: 'not_found',
		});
		const context = await applied<{ items: { label: string }[] }>(k, 'pets.aiContext', {}, AI);
		expect(context.items.map((i) => i.label)).toEqual(['Karabaş']);
		await expect(applied(k, 'pets.archivePet', { id: cat.id }, admin.actor)).rejects.toMatchObject({
			code: 'not_found',
		});
	});
});

describe('capabilities', () => {
	it('turns a supervised member’s changes into drafts that an admin approves', async () => {
		const kid = await person(k, 'supervised', 'Elif');
		const result = await k.runner.invoke('pets.addPet', { name: 'Fındık' }, kid.actor);
		expect(result.status).toBe('drafted');
		expect(await pets()).toHaveLength(0);
		if (result.status !== 'drafted') return;
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect((await pets()).map((p) => p.name)).toEqual(['Fındık']);
		// They may look, though.
		expect(await k.route('pets.listPets').call({ actor: kid.actor })).toHaveLength(1);
		// A treatment from them waits too.
		const treatment = await k.runner.invoke(
			'pets.addTreatment',
			{ petId: (await pets())[0]?.id, givenOn: '2026-10-01' },
			kid.actor,
		);
		expect(treatment.status).toBe('drafted');
	});

	it('lets the AI propose a treatment only as a draft', async () => {
		const cat = await addPet();
		const result = await k.runner.invoke(
			'pets.addTreatment',
			{ petId: cat.id, givenOn: '2026-10-01', product: 'Drontal' },
			AI,
		);
		expect(result.status).toBe('drafted');
		expect(await treatments(cat.id)).toHaveLength(0);
		const catalog = k.ctx.actions.aiCatalog().map((a) => a.id);
		expect(catalog).toContain('pets.addTreatment');
		expect(catalog).not.toContain('pets.addPet');
	});
});

describe('AI context', () => {
	it('lists pets with species and breed, a path and neither chip number nor notes', async () => {
		await addPet({ chipNumber: 'SECRETCHIP', notes: 'private note', vet: 'Pati Klinik 0212' });
		const context = await applied<unknown>(k, 'pets.aiContext', {}, AI);
		expect(context).toMatchObject({
			kind: 'pet',
			label: 'Pets',
			items: [{ label: 'Pamuk', details: 'cat, Tekir' }],
		});
		expect(JSON.stringify(context)).not.toMatch(/SECRETCHIP|private note|Pati Klinik/);
	});

	it('is refused for the AI when the area is off, and still open to people', async () => {
		await addPet();
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'pets', access: 'off' },
			admin.actor,
		);
		await expect(k.runner.invoke('pets.aiContext', {}, AI)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.invoke('pets.aiContext', {}, admin.actor)).resolves.toMatchObject({
			status: 'applied',
		});
	});

	it('keeps a locked pets area’s obligations out of records’ context too', async () => {
		await withRabies();
		const labels = async (actor: typeof AI) =>
			(await applied<{ items: { label: string }[] }>(k, 'records.aiContext', {}, actor)).items.map(
				(i) => i.label,
			);
		expect(await labels(AI)).toEqual(['Rabies (Pamuk)']);
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'pets', access: 'off' },
			admin.actor,
		);
		expect(await labels(AI)).toEqual([]);
		expect(await labels(admin.actor)).toEqual(['Rabies (Pamuk)']);
	});

	it('is named by the extension and is read-only', () => {
		const ext = k.registry.extensions.find((e) => e.id === 'pets');
		expect(ext?.ai?.context).toBe('pets.aiContext');
		expect(k.registry.actions.get('pets.aiContext')?.readOnly).toBe(true);
	});
});
