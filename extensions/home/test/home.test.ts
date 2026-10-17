import type { Obligation } from '@famos/ext-records/contract';
import { FamosError } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	HOME_PRESET_IDS,
	HOME_PRESETS,
	type Home,
	ITEM_PRESETS,
	type Item,
	itemUrl,
	type Service,
} from '../src/contract/index.ts';
import { AI, applied, at, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
});
afterEach(() => k.close());

const addHome = (input: Record<string, unknown> = {}, actor = admin.actor) =>
	applied<Home>(
		k,
		'home.addHome',
		{ name: 'Our flat', address: 'Moda Cd. 12, Kadıköy', tenure: 'tenant', ...input },
		actor,
	);
const addItem = (homeId: string, input: Record<string, unknown> = {}, actor = admin.actor) =>
	applied<Item>(
		k,
		'home.addItem',
		{ homeId, name: 'Washing machine', brand: 'Bosch', model: 'WAX32', room: 'Kitchen', ...input },
		actor,
	);
const addService = (homeId: string, input: Record<string, unknown> = {}) =>
	applied<Service>(
		k,
		'home.addService',
		{ homeId, kind: 'electricity', provider: 'Enerjisa', accountNumber: '4455667788', ...input },
		admin.actor,
	);
const homes = (): Promise<Home[]> => k.route('home.listHomes').call();
const items = (homeId?: string): Promise<Item[]> =>
	k.route('home.listItems').call({ query: homeId ? { homeId } : {} });
const services = (homeId?: string): Promise<Service[]> =>
	k.route('home.listServices').call({ query: homeId ? { homeId } : {} });
const obligations = (recordId: string, status = 'open'): Promise<Obligation[]> =>
	k.route('records.listObligations').call({ query: { recordId, status } });

describe('homes', () => {
	it('adds, lists, reads and changes a home', async () => {
		const flat = await addHome({ notes: 'Landlord: Mr. Kaya' });
		expect(flat).toMatchObject({ name: 'Our flat', tenure: 'tenant' });
		expect(flat.id).toMatch(/^home_[0-9a-f]{8}-/);
		expect(await homes()).toHaveLength(1);
		expect(await k.route('home.getHome').call({ params: { homeId: flat.id } })).toMatchObject({
			address: 'Moda Cd. 12, Kadıköy',
			notes: 'Landlord: Mr. Kaya',
		});

		const changed = await applied<Home>(
			k,
			'home.updateHome',
			{ id: flat.id, home: { name: 'Flat', address: '', tenure: 'owner', notes: null } },
			admin.actor,
		);
		expect(changed).toMatchObject({ name: 'Flat', address: '', tenure: 'owner', notes: null });
		// The form always sends the whole home: one that leaves fields out is refused, not cleared.
		await expect(
			k.runner.invoke('home.updateHome', { id: flat.id, home: { name: 'Flat 2' } }, admin.actor),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(await k.route('home.getHome').call({ params: { homeId: flat.id } })).toMatchObject({
			name: 'Flat',
			tenure: 'owner',
		});
	});

	it('refuses a missing name, a bad tenure and an unknown home', async () => {
		const fail = (input: Record<string, unknown>) =>
			addHome(input).then(
				() => null,
				(e: unknown) => e,
			);
		expect(await fail({ name: '  ' })).toBeInstanceOf(FamosError);
		expect(await fail({ tenure: 'squatter' })).toBeInstanceOf(FamosError);
		expect(await homes()).toHaveLength(0);
		await expect(
			k
				.route('home.getHome')
				.call({ params: { homeId: 'home_00000000-0000-7000-8000-000000000001' } }),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('presets', () => {
	it('creates the picked obligations with the preset’s repeat and lead time', async () => {
		const flat = await addHome({
			obligations: [
				{ preset: 'home_insurance', title: 'Home insurance', dueDate: '2026-12-01' },
				{ preset: 'heating_service', title: 'Heating service', dueDate: '2027-02-01' },
				{ preset: 'lease_review', title: 'Lease review', dueDate: '2027-05-01' },
			],
		});
		const list = await obligations(flat.id);
		expect(list.map((o) => o.title)).toEqual(['Home insurance', 'Heating service', 'Lease review']);
		expect(list).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'home_insurance',
					dueDate: '2026-12-01',
					every: { years: 1 },
					leadDays: 30,
					audience: 'home.view',
					recordKind: 'home',
					recordName: 'Our flat',
					recordUrl: `/home/${flat.id}`,
				}),
				expect.objectContaining({ kind: 'heating_service', leadDays: 21 }),
			]),
		);
	});

	it('takes the interval and lead time the person chose', async () => {
		const flat = await addHome({
			obligations: [
				{
					preset: 'home_insurance',
					title: 'Home insurance',
					dueDate: '2026-12-01',
					every: { months: 6 },
					leadDays: 45,
				},
				{ preset: 'lease_review', title: 'Lease', dueDate: '2027-05-01', every: null },
				{ preset: 'alarm_check', title: 'Alarms', dueDate: '2027-05-01' },
			],
		});
		const byKind = Object.fromEntries((await obligations(flat.id)).map((o) => [o.kind, o]));
		expect(byKind.home_insurance).toMatchObject({ every: { months: 6 }, leadDays: 45 });
		expect(byKind.lease_review).toMatchObject({ every: null, leadDays: 30 });
		expect(byKind.alarm_check).toMatchObject({ every: { years: 1 }, leadDays: 14 });
		await expect(
			addHome({
				obligations: [
					{ preset: 'alarm_check', title: 'x', dueDate: '2027-05-01', every: { years: 0 } },
				],
			}),
		).rejects.toThrow();
	});

	it('offers presets for the home and for things, each with a title key and a repeat', () => {
		expect(HOME_PRESETS.map((p) => p.id)).toEqual(HOME_PRESET_IDS);
		expect(HOME_PRESETS.map((p) => p.id)).toEqual(
			expect.arrayContaining(['home_insurance', 'heating_service', 'alarm_check', 'lease_review']),
		);
		// Nothing in a preset names a country or a product.
		expect(HOME_PRESETS.map((p) => p.id).join(' ')).not.toMatch(/earthquake|dask|boiler|chimney/);
		expect(ITEM_PRESETS.map((p) => [p.id, p.every])).toEqual([
			['filter_change', { months: 6 }],
			['service', { years: 1 }],
		]);
		for (const preset of [...HOME_PRESETS, ...ITEM_PRESETS]) {
			expect(preset.titleKey).toMatch(/^home:preset_/);
		}
	});

	it('gives a thing its picked upkeep, and refuses an unknown preset without adding anything', async () => {
		const flat = await addHome();
		const filter = await addItem(flat.id, {
			name: 'Water filter',
			obligations: [{ preset: 'filter_change', title: 'Filter', dueDate: '2027-01-10' }],
		});
		expect(await obligations(filter.id)).toMatchObject([
			{
				kind: 'filter_change',
				every: { months: 6 },
				recordKind: 'home_item',
				recordName: 'Water filter',
			},
		]);
		await expect(
			addItem(flat.id, {
				name: 'Fridge',
				obligations: [{ preset: 'flying', title: 'x', dueDate: '2027-01-10' }],
			}),
		).rejects.toBeInstanceOf(FamosError);
		expect((await items()).map((i) => i.name)).toEqual(['Water filter']);
	});

	it('moves the next date by the preset’s cycle when one is done', async () => {
		const flat = await addHome({
			obligations: [{ preset: 'alarm_check', title: 'Alarms', dueDate: '2026-10-20' }],
		});
		const [duty] = await obligations(flat.id);
		const done = await applied<Obligation>(
			k,
			'records.completeObligation',
			{ id: duty?.id, doneOn: '2026-10-10' },
			admin.actor,
		);
		expect(done.dueDate).toBe('2027-10-20');
	});
});

describe('things and their warranty', () => {
	it('adds a thing with every field and lists it by home', async () => {
		const flat = await addHome();
		const other = await addHome({ name: 'Summer house' });
		const wm = await addItem(flat.id, {
			serial: 'SN-123',
			purchasedOn: '2026-09-20',
			notes: 'Delivered by Arçelik Plaza',
		});
		await addItem(other.id, { name: 'Grill' });
		expect(wm).toMatchObject({
			homeId: flat.id,
			brand: 'Bosch',
			serial: 'SN-123',
			purchasedOn: '2026-09-20',
			warrantyUntil: null,
		});
		expect(wm.id).toMatch(/^home_item_/);
		expect((await items()).map((i) => i.name)).toEqual(['Washing machine', 'Grill']);
		expect((await items(flat.id)).map((i) => i.name)).toEqual(['Washing machine']);
		expect(await k.route('home.getItem').call({ params: { itemId: wm.id } })).toMatchObject({
			room: 'Kitchen',
		});
	});

	it('creates a "Warranty ends" duty from the date, moves it with the date and removes it with the date', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id, { warrantyUntil: '2028-09-20' });
		expect(await obligations(wm.id)).toMatchObject([
			{
				kind: 'warranty_end',
				title: 'Warranty ends',
				dueDate: '2028-09-20',
				every: null,
				lapses: true,
				leadDays: 30,
				audience: 'home.view',
				recordKind: 'home_item',
				recordName: 'Washing machine',
				recordUrl: itemUrl(wm.id),
			},
		]);
		const [first] = await obligations(wm.id);

		// A new date moves the same duty.
		await applied(k, 'home.updateItem', { id: wm.id, warrantyUntil: '2029-09-20' }, admin.actor);
		const moved = await obligations(wm.id);
		expect(moved).toHaveLength(1);
		expect(moved[0]).toMatchObject({ id: first?.id, dueDate: '2029-09-20' });

		// Other changes leave it alone, and a rename follows through to the record's name.
		await applied(k, 'home.updateItem', { id: wm.id, name: 'Dishwasher' }, admin.actor);
		expect(await obligations(wm.id)).toMatchObject([
			{ id: first?.id, dueDate: '2029-09-20', recordName: 'Dishwasher' },
		]);

		// No date, no duty.
		const cleared = await applied<Item>(
			k,
			'home.updateItem',
			{ id: wm.id, warrantyUntil: null },
			admin.actor,
		);
		expect(cleared.warrantyUntil).toBeNull();
		expect(await obligations(wm.id)).toHaveLength(0);

		// And a date again makes a new one.
		await applied(k, 'home.updateItem', { id: wm.id, warrantyUntil: '2030-01-05' }, admin.actor);
		expect(await obligations(wm.id)).toMatchObject([{ dueDate: '2030-01-05' }]);
	});

	it('never shows an ended warranty as late, and drops it from what is coming up', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id, { warrantyUntil: '2026-10-20' });
		const upcoming = async () =>
			(
				(await k.route('records.listUpcoming').call({ query: { days: 30 } })) as Obligation[]
			).filter((o) => o.recordId === wm.id);
		expect(await upcoming()).toMatchObject([{ title: 'Warranty ends', lapses: true }]);
		k.clock.set(at('2026-10-21', '00:30'));
		expect(await upcoming()).toEqual([]);
		// The thing keeps its date.
		expect(await obligations(wm.id)).toMatchObject([{ dueDate: '2026-10-20', lapses: true }]);
	});

	it('turns a warranty date kept as a duty back into one that lapses when the thing is saved', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id, { warrantyUntil: '2028-09-20' });
		const [first] = await obligations(wm.id);
		await applied(
			k,
			'records.updateObligation',
			{
				id: first?.id,
				obligation: {
					title: 'Warranty ends',
					dueDate: '2028-09-20',
					lapses: false,
					leadDays: 10,
					notes: 'Keep the box',
				},
			},
			admin.actor,
		);
		expect(await obligations(wm.id)).toMatchObject([{ lapses: false }]);

		await applied(k, 'home.updateItem', { id: wm.id, room: 'Laundry' }, admin.actor);
		expect(await obligations(wm.id)).toMatchObject([
			{ id: first?.id, lapses: true, dueDate: '2028-09-20', leadDays: 10, notes: 'Keep the box' },
		]);

		// A new date moves it and keeps it lapsing too.
		await applied(
			k,
			'records.updateObligation',
			{
				id: first?.id,
				obligation: { title: 'Warranty ends', dueDate: '2028-09-20', lapses: false },
			},
			admin.actor,
		);
		await applied(k, 'home.updateItem', { id: wm.id, warrantyUntil: '2029-09-20' }, admin.actor);
		expect(await obligations(wm.id)).toMatchObject([
			{ id: first?.id, lapses: true, dueDate: '2029-09-20' },
		]);
	});

	it('writes the duty title in the family language', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ locale: 'tr' },
			(await person(k, 'admin', 'Z')).actor,
		);
		const flat = await addHome();
		const wm = await addItem(flat.id, { warrantyUntil: '2028-09-20' });
		expect(await obligations(wm.id)).toMatchObject([{ title: 'Garanti bitişi' }]);
	});

	it('starts a new duty when the old one was finished, and does not repeat a finished one', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id, { warrantyUntil: '2027-01-10' });
		const [duty] = await obligations(wm.id);
		await applied(
			k,
			'records.completeObligation',
			{ id: duty?.id, doneOn: '2026-10-07' },
			admin.actor,
		);
		expect(await obligations(wm.id)).toHaveLength(0);

		// Saving other fields does not bring the finished duty back.
		await applied(k, 'home.updateItem', { id: wm.id, room: 'Laundry' }, admin.actor);
		expect(await obligations(wm.id)).toHaveLength(0);

		// A different date (the warranty was extended) is a new duty.
		await applied(k, 'home.updateItem', { id: wm.id, warrantyUntil: '2028-01-10' }, admin.actor);
		expect(await obligations(wm.id)).toMatchObject([{ dueDate: '2028-01-10' }]);

		// Clearing the date after the duty was removed by hand does not fail.
		const [again] = await obligations(wm.id);
		await applied(k, 'records.removeObligation', { id: again?.id }, admin.actor);
		await applied(k, 'home.updateItem', { id: wm.id, warrantyUntil: null }, admin.actor);
		expect(await obligations(wm.id)).toHaveLength(0);
	});

	it('changes only the fields that are given', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id, {
			serial: 'SN-1',
			purchasedOn: '2026-09-20',
			warrantyUntil: '2028-09-20',
			notes: 'Blue',
		});
		const changed = await applied<Item>(
			k,
			'home.updateItem',
			{ id: wm.id, model: 'WAX32M', serial: null },
			admin.actor,
		);
		expect(changed).toMatchObject({
			name: 'Washing machine',
			room: 'Kitchen',
			brand: 'Bosch',
			model: 'WAX32M',
			serial: null,
			purchasedOn: '2026-09-20',
			warrantyUntil: '2028-09-20',
			notes: 'Blue',
		});
	});

	it('refuses a thing in an unknown or archived home, and a bad date', async () => {
		const flat = await addHome();
		await expect(addItem('home_00000000-0000-7000-8000-000000000001')).rejects.toMatchObject({
			code: 'not_found',
		});
		await expect(addItem(flat.id, { warrantyUntil: '2028-13-01' })).rejects.toBeInstanceOf(
			FamosError,
		);
		await applied(k, 'home.archiveHome', { id: flat.id }, admin.actor);
		await expect(addItem(flat.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('keeps the reviewer-only home name out of storage', async () => {
		const flat = await addHome();
		const item = await applied<Item & { homeName?: string }>(
			k,
			'home.addItem',
			{ homeId: flat.id, name: 'Oven', homeName: 'Our flat' },
			admin.actor,
		);
		expect(item).not.toHaveProperty('homeName');
	});
});

describe('services', () => {
	it('adds, lists, changes and validates a service', async () => {
		const flat = await addHome();
		const power = await addService(flat.id, { dueDay: 15 });
		expect(power).toMatchObject({ kind: 'electricity', provider: 'Enerjisa', dueDay: 15 });
		expect(power.id).toMatch(/^home_service_/);
		expect(await services(flat.id)).toHaveLength(1);
		expect(await services(`home_00000000-0000-7000-8000-000000000001`)).toHaveLength(0);
		expect(
			await k.route('home.getService').call({ params: { serviceId: power.id } }),
		).toMatchObject({ accountNumber: '4455667788' });

		const changed = await applied<Service>(
			k,
			'home.updateService',
			{
				id: power.id,
				service: { kind: 'gas', provider: 'Igdaş', accountNumber: null, dueDay: null, notes: null },
			},
			admin.actor,
		);
		expect(changed).toMatchObject({
			kind: 'gas',
			provider: 'Igdaş',
			accountNumber: null,
			dueDay: null,
		});
		await expect(
			k.runner.invoke(
				'home.updateService',
				{ id: power.id, service: { provider: 'Igdaş' } },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });

		await expect(addService(flat.id, { dueDay: 32 })).rejects.toBeInstanceOf(FamosError);
		await expect(addService(flat.id, { kind: 'lottery' })).rejects.toBeInstanceOf(FamosError);
		await expect(addService(flat.id, { provider: ' ' })).rejects.toBeInstanceOf(FamosError);
	});

	it('is a record: a duty on a service follows its provider’s name', async () => {
		const flat = await addHome();
		const net = await addService(flat.id, { kind: 'internet', provider: 'Turknet' });
		await applied(
			k,
			'records.addObligation',
			{
				recordId: net.id,
				recordKind: 'home_service',
				recordName: 'Turknet',
				title: 'Contract ends',
				dueDate: '2027-03-01',
			},
			admin.actor,
		);
		await applied(
			k,
			'home.updateService',
			{
				id: net.id,
				service: {
					kind: 'internet',
					provider: 'Superonline',
					accountNumber: null,
					dueDay: null,
					notes: null,
				},
			},
			admin.actor,
		);
		expect(await obligations(net.id)).toMatchObject([{ recordName: 'Superonline' }]);
	});
});

describe('the AI', () => {
	it('is offered only things to add or change', () => {
		const ids = k.ctx.actions.aiCatalog().map((a) => a.id);
		expect(ids).toEqual(expect.arrayContaining(['home.addItem', 'home.updateItem']));
		expect(ids.filter((id) => id.startsWith('home.')).sort()).toEqual([
			'home.addItem',
			'home.updateItem',
		]);
	});
});

describe('records follow the home', () => {
	it('renames the record when the name changes', async () => {
		const flat = await addHome({
			obligations: [{ preset: 'home_insurance', title: 'Konut sigortası', dueDate: '2026-11-20' }],
		});
		await applied(
			k,
			'home.updateHome',
			{ id: flat.id, home: { name: 'Flat in Moda', address: '', tenure: 'tenant', notes: null } },
			admin.actor,
		);
		expect((await obligations(flat.id))[0]).toMatchObject({
			recordName: 'Flat in Moda',
			recordUrl: `/home/${flat.id}`,
		});
	});

	it('archives a home with its things, services, obligations and papers, and hides them everywhere', async () => {
		const flat = await addHome({
			obligations: [{ preset: 'home_insurance', title: 'Konut sigortası', dueDate: '2026-11-20' }],
		});
		const keep = await addHome({ name: 'Summer house' });
		const wm = await addItem(flat.id, { warrantyUntil: '2028-09-20' });
		const power = await addService(flat.id);
		await addItem(keep.id, { name: 'Grill' });

		await applied(k, 'home.archiveHome', { id: flat.id }, admin.actor);
		expect((await homes()).map((h) => h.name)).toEqual(['Summer house']);
		expect((await items()).map((i) => i.name)).toEqual(['Grill']);
		expect(await services()).toHaveLength(0);
		for (const id of [flat.id, wm.id]) {
			expect(await obligations(id)).toHaveLength(0);
			expect(await obligations(id, 'archived')).toHaveLength(1);
		}
		await expect(k.route('home.getItem').call({ params: { itemId: wm.id } })).rejects.toMatchObject(
			{ code: 'not_found' },
		);
		await expect(
			k.route('home.getService').call({ params: { serviceId: power.id } }),
		).rejects.toMatchObject({ code: 'not_found' });
		// Gone from what the AI hears about, too.
		const homesContext = await applied<{ items: { label: string }[] }>(k, 'home.aiContext', {}, AI);
		const itemsContext = await applied<{ items: { label: string }[] }>(
			k,
			'home.aiContextItems',
			{},
			AI,
		);
		expect(homesContext.items.map((i) => i.label)).toEqual(['Summer house']);
		expect(itemsContext.items.map((i) => i.label)).toEqual(['Grill']);
		await expect(
			applied(k, 'home.archiveHome', { id: flat.id }, admin.actor),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('archives a single thing or service with its duties', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id, { warrantyUntil: '2028-09-20' });
		const power = await addService(flat.id);
		await applied(k, 'home.archiveItem', { id: wm.id }, admin.actor);
		await applied(k, 'home.archiveService', { id: power.id }, admin.actor);
		expect(await items(flat.id)).toHaveLength(0);
		expect(await services(flat.id)).toHaveLength(0);
		expect(await obligations(wm.id)).toHaveLength(0);
		expect(await homes()).toHaveLength(1);
	});
});

describe('capabilities', () => {
	it('turns a supervised member’s changes into drafts that an admin approves, while they may look', async () => {
		const kid = await person(k, 'supervised', 'Elif');
		const result = await k.runner.invoke('home.addHome', { name: 'Granny’s' }, kid.actor);
		expect(result.status).toBe('drafted');
		expect(await homes()).toHaveLength(0);
		if (result.status !== 'drafted') return;
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect((await homes()).map((h) => h.name)).toEqual(['Granny’s']);
		expect(await k.route('home.listHomes').call({ actor: kid.actor })).toHaveLength(1);
		const service = { homeId: (await homes())[0]?.id, provider: 'P' };
		expect((await k.runner.invoke('home.addService', service, kid.actor)).status).toBe('drafted');
	});

	it('lets the AI propose a thing or a change to one only as a draft', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id);
		const added = await k.runner.invoke(
			'home.addItem',
			{ homeId: flat.id, name: 'Oven', warrantyUntil: '2028-01-01' },
			AI,
		);
		expect(added.status).toBe('drafted');
		const changed = await k.runner.invoke(
			'home.updateItem',
			{ id: wm.id, warrantyUntil: '2029-01-01' },
			AI,
		);
		expect(changed.status).toBe('drafted');
		expect(await items()).toHaveLength(1);
		expect(await obligations(wm.id)).toHaveLength(0);
	});

	it('takes back an approved change, restoring only the fields it changed', async () => {
		const flat = await addHome();
		const wm = await addItem(flat.id, { warrantyUntil: '2028-09-20', notes: 'Blue' });
		const changed = await k.runner.invoke(
			'home.updateItem',
			{ id: wm.id, warrantyUntil: '2029-01-01', notes: null },
			AI,
		);
		if (changed.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(changed.draftId, admin.actor);
		expect(await obligations(wm.id)).toMatchObject([{ dueDate: '2029-01-01' }]);
		// A later change by hand to another field stays.
		await applied(k, 'home.updateItem', { id: wm.id, room: 'Laundry' }, admin.actor);

		expect((await k.runner.undoDraft(changed.draftId, admin.actor)).status).toBe('undone');
		expect(await items()).toMatchObject([
			{ id: wm.id, room: 'Laundry', notes: 'Blue', warrantyUntil: '2028-09-20' },
		]);
		expect(await obligations(wm.id)).toMatchObject([{ dueDate: '2028-09-20' }]);
	});
});

describe('AI context', () => {
	it('lists homes and things with short details and no serial, account number, address or notes', async () => {
		const flat = await addHome({ notes: 'private note' });
		await addItem(flat.id, {
			serial: 'SECRET-SERIAL',
			notes: 'secret item note',
			warrantyUntil: '2028-09-20',
		});
		await addService(flat.id, { accountNumber: '9988776655', notes: 'secret service note' });
		const homesContext = await applied<unknown>(k, 'home.aiContext', {}, AI);
		const itemsContext = await applied<unknown>(k, 'home.aiContextItems', {}, AI);
		expect(homesContext).toMatchObject({
			kind: 'home',
			items: [{ id: flat.id, label: 'Our flat', details: 'rented', url: `/home/${flat.id}` }],
		});
		expect(itemsContext).toMatchObject({
			kind: 'home_item',
			items: [
				{
					label: 'Washing machine',
					details: 'Bosch WAX32, Kitchen, in Our flat, warranty until 2028-09-20',
				},
			],
		});
		expect(JSON.stringify([homesContext, itemsContext])).not.toMatch(
			/SECRET|secret|private note|9988776655|Moda|4455667788/,
		);
	});

	it('is refused for the AI when the area is off, and still open to people', async () => {
		await addHome();
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'home', access: 'off' },
			admin.actor,
		);
		for (const id of ['home.aiContext', 'home.aiContextItems']) {
			await expect(k.runner.invoke(id, {}, AI)).rejects.toMatchObject({ code: 'forbidden' });
			await expect(k.runner.invoke(id, {}, admin.actor)).resolves.toMatchObject({
				status: 'applied',
			});
		}
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).not.toContain('home.addItem');
	});

	it('keeps a locked home area’s duties out of records’ context too', async () => {
		const flat = await addHome({
			obligations: [{ preset: 'home_insurance', title: 'Konut sigortası', dueDate: '2026-11-20' }],
		});
		await addItem(flat.id, { warrantyUntil: '2028-09-20' });
		const labels = async (actor: typeof AI) =>
			(await applied<{ items: { label: string }[] }>(k, 'records.aiContext', {}, actor)).items.map(
				(i) => i.label,
			);
		expect(await labels(AI)).toEqual([
			'Konut sigortası (Our flat)',
			'Warranty ends (Washing machine)',
		]);
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'home', access: 'off' },
			admin.actor,
		);
		expect(await labels(AI)).toEqual([]);
		expect(await labels(admin.actor)).toHaveLength(2);
	});

	it('is named by the extension and both actions are read-only', () => {
		const ext = k.registry.extensions.find((e) => e.id === 'home');
		expect(ext?.ai?.context).toEqual(['home.aiContext', 'home.aiContextItems']);
		expect(k.registry.actions.get('home.aiContext')?.readOnly).toBe(true);
		expect(k.registry.actions.get('home.aiContextItems')?.readOnly).toBe(true);
		expect(k.ctx.actions.aiContextActions().get('home')).toEqual([
			'home.aiContext',
			'home.aiContextItems',
		]);
	});
});
