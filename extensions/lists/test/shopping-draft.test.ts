import { describe, expect, it } from 'vitest';
import type { ShoppingItem } from '../src/contract/index.ts';
import { itemsOnList, quantityChanges } from '../src/web/shopping-draft.ts';

const item = (title: string, quantity: string | null, doneAt: number | null = null) =>
	({
		id: `shop_item_${title}`,
		listId: 'shop_list_1',
		title,
		quantity,
		category: 'other',
		doneAt,
		doneBy: null,
		addedBy: null,
		createdAt: 0,
		updatedAt: 0,
	}) as unknown as ShoppingItem;

describe('quantityChanges', () => {
	const onList = [item('Rice', '1 kg'), item('Oat milk', '1 l'), item('Salt', null)];

	it('names an item on the list whose quantity would be replaced', () => {
		expect(quantityChanges([{ title: 'rice', quantity: 'a bag' }], onList, 'en')).toEqual([
			{ title: 'Rice', from: '1 kg', to: 'a bag' },
		]);
	});

	it('says nothing for an empty or null quantity, the same quantity, or an item not on the list', () => {
		expect(
			quantityChanges(
				[
					{ title: 'Oat milk', quantity: null },
					{ title: 'Oat milk', quantity: '' },
					{ title: 'Rice', quantity: '1 kg' },
					{ title: 'Salt', quantity: '1 pack' },
					{ title: 'Butter', quantity: '250 g' },
				],
				onList,
				'en',
			),
		).toEqual([]);
	});

	it('says nothing when the add keeps what is on the list', () => {
		expect(quantityChanges([{ title: 'Rice', quantity: '2 kg' }], onList, 'en', 'keep')).toEqual(
			[],
		);
	});

	it('prefers the open item over a bought one with the same name', () => {
		const both = [item('Rice', '5 kg', 100), item('Rice', '1 kg')];
		expect(quantityChanges([{ title: 'Rice', quantity: '2 kg' }], both, 'en')).toEqual([
			{ title: 'Rice', from: '1 kg', to: '2 kg' },
		]);
	});
});

describe('itemsOnList', () => {
	it('answers once the list has loaded, and asks again only when the answer is old', async () => {
		let clock = 0;
		let calls = 0;
		const ask = itemsOnList(
			async () => {
				calls++;
				return [item('Rice', '1 kg')];
			},
			1000,
			() => clock,
		);
		expect(ask(undefined)).toBeUndefined();
		await Promise.resolve();
		await Promise.resolve();
		expect(ask(undefined)?.[0]?.title).toBe('Rice');
		expect(calls).toBe(1);
		clock = 2000;
		expect(ask(undefined)?.[0]?.title).toBe('Rice');
		expect(calls).toBe(2);
	});
});
