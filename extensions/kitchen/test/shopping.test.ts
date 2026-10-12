import type { ShoppingItem } from '@famos/ext-lists/contract';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Recipe } from '../src/contract/index.ts';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
});
afterEach(() => k.close());

const addRecipe = () =>
	applied<Recipe>(
		k,
		'kitchen.createRecipe',
		{
			title: 'Lentil soup',
			ingredients: ['1 cup red lentils', '1 onion', '2 carrots', 'Salt'],
		},
		admin.actor,
	);
const shoppingItems = async (): Promise<ShoppingItem[]> => {
	const lists: { id: string }[] = await k.route('lists.listShoppingLists').call();
	const first = lists[0];
	if (!first) return [];
	return k.route('lists.listShoppingItems').call({ params: { listId: first.id } });
};

describe('ingredients to the shopping list', () => {
	it('adds the product as the title and the amount as the quantity', async () => {
		const r = await applied<Recipe>(
			k,
			'kitchen.createRecipe',
			{
				title: 'Shakshuka',
				ingredients: [
					'2 tbsp olive oil',
					'1 tin chopped tomatoes (400 g)',
					'4 eggs',
					'60 g feta, crumbled',
				],
			},
			admin.actor,
		);
		const result = await applied<{ added: number; alreadyThere: number }>(
			k,
			'kitchen.addIngredientsToShopping',
			{ recipeId: r.id, lines: r.ingredients },
			admin.actor,
		);
		expect(result).toMatchObject({ added: 4, alreadyThere: 0 });
		const items = (await shoppingItems()).map((i) => ({ title: i.title, quantity: i.quantity }));
		expect(items.toSorted((a, b) => a.title.localeCompare(b.title))).toEqual([
			{ title: 'Chopped tomatoes', quantity: '1 tin (400 g)' },
			{ title: 'Eggs', quantity: '4' },
			{ title: 'Feta', quantity: '60 g' },
			{ title: 'Olive oil', quantity: '2 tbsp' },
		]);
	});

	it('matches an item already on the list instead of adding it again', async () => {
		const r = await addRecipe();
		await applied(k, 'lists.addShoppingItems', { items: [{ title: 'onion' }] }, admin.actor);
		const result = await applied<{ added: number; alreadyThere: number }>(
			k,
			'kitchen.addIngredientsToShopping',
			{ recipeId: r.id, lines: ['1 onion', '2 carrots'] },
			admin.actor,
		);
		expect(result).toMatchObject({ added: 1, alreadyThere: 1 });
		const items = await shoppingItems();
		expect(items.map((i) => i.title).toSorted()).toEqual(['Carrots', 'onion']);
		expect(items.find((i) => i.title === 'onion')?.quantity).toBeNull();
	});

	it('does not duplicate what is on the list, and counts it', async () => {
		const r = await addRecipe();
		const add = (lines: string[]) =>
			applied<{ added: number; alreadyThere: number }>(
				k,
				'kitchen.addIngredientsToShopping',
				{ recipeId: r.id, lines },
				admin.actor,
			);
		await add(['1 onion']);
		expect(await add(['1 onion', 'Salt'])).toMatchObject({ added: 1, alreadyThere: 1 });
		expect(await shoppingItems()).toHaveLength(2);
	});

	it('never lowers or replaces what is already on the list', async () => {
		const r = await applied<Recipe>(
			k,
			'kitchen.createRecipe',
			{ title: 'Omelette', ingredients: ['4 eggs', '20 g butter'] },
			admin.actor,
		);
		await applied(
			k,
			'lists.addShoppingItems',
			{ items: [{ title: 'Eggs', quantity: '12' }] },
			admin.actor,
		);
		const result = await applied<{ added: number; alreadyThere: number }>(
			k,
			'kitchen.addIngredientsToShopping',
			{ recipeId: r.id, lines: r.ingredients },
			admin.actor,
		);
		expect(result).toMatchObject({ added: 1, alreadyThere: 1 });
		const items = await shoppingItems();
		expect(items.find((i) => i.title === 'Eggs')?.quantity).toBe('12');
		expect(items.find((i) => i.title === 'Butter')?.quantity).toBe('20 g');
	});

	it('ignores lines that are not in the recipe', async () => {
		const r = await addRecipe();
		const result = await applied<{ added: number }>(
			k,
			'kitchen.addIngredientsToShopping',
			{ recipeId: r.id, lines: ['a line someone made up'] },
			admin.actor,
		);
		expect(result.added).toBe(0);
		expect(await shoppingItems()).toHaveLength(0);
	});

	it('matches lines loosely and reports the ones that match nothing', async () => {
		const r = await addRecipe();
		const result = await applied<{ added: number; alreadyThere: number; unknownLines: string[] }>(
			k,
			'kitchen.addIngredientsToShopping',
			{ recipeId: r.id, lines: ['  1 ONION. ', '2  carrots', 'a line someone made up'] },
			admin.actor,
		);
		expect(result).toMatchObject({
			added: 2,
			alreadyThere: 0,
			unknownLines: ['a line someone made up'],
		});
		expect((await shoppingItems()).map((i) => i.title).toSorted()).toEqual(['Carrots', 'Onion']);
	});

	it('refuses with a clear error when Lists is turned off, and adds nothing', async () => {
		const r = await addRecipe();
		await applied(
			k,
			'core.setFeatureEnabled',
			{ extensionId: 'lists', enabled: false },
			admin.actor,
		);
		await expect(
			applied(
				k,
				'kitchen.addIngredientsToShopping',
				{ recipeId: r.id, lines: ['1 onion'] },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'feature_off', message: expect.stringContaining('lists') });
		await applied(
			k,
			'core.setFeatureEnabled',
			{ extensionId: 'lists', enabled: true },
			admin.actor,
		);
		expect(await shoppingItems()).toHaveLength(0);
	});

	it('applies the lists permission rules to the person', async () => {
		const r = await addRecipe();
		const guest = await person(k, 'guest', 'Visitor');
		await expect(
			k.runner.invoke(
				'kitchen.addIngredientsToShopping',
				{ recipeId: r.id, lines: ['1 onion'] },
				guest.actor,
			),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect(await shoppingItems()).toHaveLength(0);
	});

	it('refuses an unknown or archived recipe', async () => {
		const r = await addRecipe();
		await applied(k, 'kitchen.archiveRecipe', { id: r.id }, admin.actor);
		await expect(
			applied(
				k,
				'kitchen.addIngredientsToShopping',
				{ recipeId: r.id, lines: ['1 onion'] },
				admin.actor,
			),
		).rejects.toMatchObject({ code: 'not_found' });
	});
});
