import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';
import { type AddedItems, alreadyOnList } from '../src/web/already-on-list.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
});
afterEach(() => k.close());

async function add(items: { title: string; quantity?: string }[]): Promise<AddedItems> {
	const { actor } = await k.member('admin');
	const result = await k.runner.invoke('lists.addShoppingItems', { items }, actor);
	if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
	return result.output as AddedItems;
}

describe('an add that finds its items on the list', () => {
	it('names what was there already, and whether its amount changed', async () => {
		expect(
			alreadyOnList(await add([{ title: 'Milk' }, { title: 'Bread', quantity: '1' }])),
		).toEqual([]);
		const again = alreadyOnList(
			await add([{ title: 'milk' }, { title: 'Bread', quantity: '2' }, { title: 'Eggs' }]),
		);
		expect(
			again.map(({ title, quantity, quantityChanged }) => ({ title, quantity, quantityChanged })),
		).toEqual([
			{ title: 'Milk', quantity: null, quantityChanged: false },
			{ title: 'Bread', quantity: '2', quantityChanged: true },
		]);
	});

	it('does not count a bought item that came back', async () => {
		const first = await add([{ title: 'Milk' }]);
		const { actor } = await k.member('admin');
		await k.runner.invoke(
			'lists.checkShoppingItem',
			{ id: first.addedIds[0] as string, done: true },
			actor,
		);
		expect(alreadyOnList(await add([{ title: 'Milk' }]))).toEqual([]);
	});
});
