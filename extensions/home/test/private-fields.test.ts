import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item, Service } from '../src/contract/index.ts';
import { ITEM_SEARCH_KIND, SERVICE_SEARCH_KIND, searchIndex } from '../src/server/search.ts';
import { AI, applied, createKernel, type Person, person } from './support.ts';

/** A serial and an account number are shown only to people who may edit the home. */
let k: TestKernel;
let admin: Person;
let guest: Person;
let kid: Person;
let item: Item;
let service: Service;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
	guest = await person(k, 'guest', 'Misafir');
	kid = await person(k, 'supervised', 'Elif');
	const flat = await applied<{ id: string }>(
		k,
		'home.addHome',
		{ name: 'Our flat', address: 'Moda Cd. 12', tenure: 'tenant' },
		admin.actor,
	);
	item = await applied<Item>(
		k,
		'home.addItem',
		{
			homeId: flat.id,
			name: 'Washing machine',
			brand: 'Bosch',
			model: 'WAX32',
			serial: 'SN-99887',
		},
		admin.actor,
	);
	service = await applied<Service>(
		k,
		'home.addService',
		{ homeId: flat.id, kind: 'electricity', provider: 'Enerjisa', accountNumber: '4455667788' },
		admin.actor,
	);
});
afterEach(() => k.close());

const call = (operationId: string, actor: Person['actor'], request: object = {}) =>
	k.route(operationId).call({ actor, query: {}, ...request });

describe('who sees account numbers and serials', () => {
	it('shows them to someone who may edit, on every route', async () => {
		const [listed] = await call('home.listItems', admin.actor);
		expect(listed.serial).toBe('SN-99887');
		expect((await call('home.getItem', admin.actor, { params: { itemId: item.id } })).serial).toBe(
			'SN-99887',
		);
		const [svc] = await call('home.listServices', admin.actor);
		expect(svc.accountNumber).toBe('4455667788');
		const one = await call('home.getService', admin.actor, { params: { serviceId: service.id } });
		expect(one.accountNumber).toBe('4455667788');
	});

	it('gives someone who may only view null for both, on every route', async () => {
		const [listed] = await call('home.listItems', guest.actor);
		expect(listed).toMatchObject({ name: 'Washing machine', serial: null });
		const one = await call('home.getItem', guest.actor, { params: { itemId: item.id } });
		expect(one).toMatchObject({ brand: 'Bosch', serial: null });
		const [svc] = await call('home.listServices', guest.actor);
		expect(svc).toMatchObject({ provider: 'Enerjisa', accountNumber: null });
		const svcOne = await call('home.getService', guest.actor, {
			params: { serviceId: service.id },
		});
		expect(svcOne).toMatchObject({ provider: 'Enerjisa', accountNumber: null });
	});

	it('does not put them in what family search reads', async () => {
		const itemDoc = await searchIndex.kinds[ITEM_SEARCH_KIND]?.load(k.ctx, item.id);
		const serviceDoc = await searchIndex.kinds[SERVICE_SEARCH_KIND]?.load(k.ctx, service.id);
		expect(JSON.stringify(itemDoc)).not.toContain('SN-99887');
		expect(JSON.stringify(serviceDoc)).not.toContain('4455667788');
	});
});

describe('a viewer cannot set or clear them through an approved suggestion', () => {
	const suggest = async (actionId: string, input: object) => {
		const result = await k.runner.invoke<unknown>(actionId, input, kid.actor);
		if (result.status !== 'drafted') throw new Error(`expected ${actionId} to be drafted`);
		await k.runner.approveDraft(result.draftId, admin.actor);
	};

	it('keeps the account number when a viewer’s whole-record update is approved', async () => {
		await suggest('home.updateService', {
			id: service.id,
			service: {
				kind: 'electricity',
				provider: 'Enerjisa Plus',
				accountNumber: null,
				dueDay: null,
				notes: null,
			},
		});
		const [svc] = await call('home.listServices', admin.actor);
		expect(svc).toMatchObject({ provider: 'Enerjisa Plus', accountNumber: '4455667788' });
	});

	it('keeps the serial when a viewer’s change to a thing is approved', async () => {
		await suggest('home.updateItem', { id: item.id, model: 'WAX33', serial: 'FORGED' });
		const [row] = await call('home.listItems', admin.actor);
		expect(row).toMatchObject({ model: 'WAX33', serial: 'SN-99887' });
	});

	it('keeps the serial when the AI acting for a viewer suggests a change', async () => {
		const ai = {
			...AI,
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: kid.id,
			roleId: 'supervised',
		};
		const result = await k.runner.invoke(
			'home.updateItem',
			{ id: item.id, serial: 'FORGED' },
			ai as never,
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(result.draftId, admin.actor);
		expect((await call('home.listItems', admin.actor))[0].serial).toBe('SN-99887');
	});

	it('stores no private value for a record a viewer suggests', async () => {
		await suggest('home.addItem', { homeId: item.homeId, name: 'Dryer', serial: 'X1' });
		await suggest('home.addService', {
			homeId: item.homeId,
			kind: 'internet',
			provider: 'Fibre',
			accountNumber: '123',
		});
		const things = await call('home.listItems', admin.actor);
		expect(things.find((t: Item) => t.name === 'Dryer')?.serial).toBeNull();
		const services = await call('home.listServices', admin.actor);
		expect(services.find((s: Service) => s.provider === 'Fibre')?.accountNumber).toBeNull();
	});

	it('lets an editor change and clear them', async () => {
		await applied(k, 'home.updateItem', { id: item.id, serial: 'SN-2' }, admin.actor);
		expect((await call('home.listItems', admin.actor))[0].serial).toBe('SN-2');
		await applied(k, 'home.updateItem', { id: item.id, serial: null }, admin.actor);
		expect((await call('home.listItems', admin.actor))[0].serial).toBeNull();
		await applied(
			k,
			'home.updateService',
			{
				id: service.id,
				service: {
					kind: 'electricity',
					provider: 'Enerjisa',
					accountNumber: '9',
					dueDay: null,
					notes: null,
				},
			},
			admin.actor,
		);
		expect((await call('home.listServices', admin.actor))[0].accountNumber).toBe('9');
		await applied(
			k,
			'home.updateService',
			{
				id: service.id,
				service: {
					kind: 'electricity',
					provider: 'Enerjisa',
					accountNumber: null,
					dueDay: null,
					notes: null,
				},
			},
			admin.actor,
		);
		expect((await call('home.listServices', admin.actor))[0].accountNumber).toBeNull();
	});
});
