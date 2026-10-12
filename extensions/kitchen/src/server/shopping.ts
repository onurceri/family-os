import { type AddShoppingItemsInput, titleKey } from '@famos/ext-lists/contract';
import { defineAction } from '@famos/sdk';
import { z } from 'zod';
import { AddToShoppingSchema } from '../contract/index.ts';
import { kitchenView } from './capabilities.ts';
import { ingredientToItem } from './ingredient.ts';
import { loadRecipe } from './recipes.ts';

/** A recipe line compared loosely: case, spacing and trailing punctuation do not count. */
const lineKey = (line: string, locale: string) =>
	line
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/[\s.,;:!]+$/u, '')
		.toLocaleLowerCase(locale);

/**
 * "Put the ingredients on the shopping list": the chosen lines of a recipe become shopping items,
 * the product as the title and the amount as the quantity ("2 tbsp olive oil" is "Olive oil",
 * "2 tbsp"). Units and preparation words come from the language packs; nothing is converted.
 * A line is matched to the recipe's text ignoring case, spacing and trailing punctuation; lines
 * that match nothing are handed back in `unknownLines`. An item already on the list is matched by
 * its title and left as it is. The lists action runs as
 * the person, so its own permission and approval rules apply; when Lists is turned off it
 * answers `feature_off`.
 */
export const addIngredientsToShopping = defineAction({
	id: 'kitchen.addIngredientsToShopping',
	title: 'Put ingredients on the shopping list',
	input: AddToShoppingSchema,
	output: z.object({
		listId: z.string(),
		added: z.number().int(),
		alreadyThere: z.number().int(),
		/** Lines that are not ingredients of this recipe, so nothing was added for them. */
		unknownLines: z.array(z.string()),
	}),
	// The lists action decides who may add and whether a draft is needed; here the person only
	// has to see the recipe.
	requires: kitchenView.id,
	approval: 'never',
	async run(uow, { recipeId, lines, listId }) {
		const recipe = await loadRecipe(uow.db, recipeId);
		const { locale } = await uow.family.settings();
		// Each recipe line by its loose key, so the item is read from the recipe's own text.
		const known = new Map(
			(JSON.parse(recipe.ingredients) as string[]).map((line) => [lineKey(line, locale), line]),
		);
		const words = {
			units: [...uow.vocabulary('lists:quantity_units'), ...uow.vocabulary('kitchen:words_units')],
			links: uow.vocabulary('kitchen:words_amount_link'),
			preparation: uow.vocabulary('kitchen:words_preparation'),
		};
		const items = new Map<string, NonNullable<ReturnType<typeof ingredientToItem>>>();
		const unknownLines: string[] = [];
		for (const line of lines) {
			const recipeLine = known.get(lineKey(line, locale));
			if (recipeLine === undefined) {
				unknownLines.push(line);
				continue;
			}
			const item = ingredientToItem(recipeLine, words, locale);
			if (!item) continue;
			const key = titleKey(item.title, locale);
			if (!items.has(key)) items.set(key, item);
		}
		if (items.size === 0) return { listId: listId ?? '', added: 0, alreadyThere: 0, unknownLines };
		// A recipe never lowers or replaces what someone already put on the list.
		const input: AddShoppingItemsInput = {
			...(listId && { listId }),
			items: [...items.values()],
			whenOnList: 'keep',
		};
		const result = await uow.run<AddShoppingItemsInput, { listId: string; addedIds: string[] }>(
			'lists.addShoppingItems',
			input,
		);
		return {
			listId: result.listId,
			added: result.addedIds.length,
			alreadyThere: items.size - result.addedIds.length,
			unknownLines,
		};
	},
});
