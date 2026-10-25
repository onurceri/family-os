import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item, Service } from '../src/contract/index.ts';
import { ITEM_SEARCH_KIND, SERVICE_SEARCH_KIND, searchIndex } from '../src/server/search.ts';
import { applied, createKernel, type Person, person } from './support.ts';

/** A serial and an account number are shown only to people who may edit the home. */
let k: TestKernel;
let admin: Person;
let guest: Person;
let item: Item;
let service: Service;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
	guest = await person(k, 'guest', 'Misafir');
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
