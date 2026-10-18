import { type DraftField, draftDate, type PresenterContext } from '@famos/ui/slots';
import { SvelteMap } from 'svelte/reactivity';
import type { AddToMealPlanInput } from '../contract/index.js';

/** A recipe's title by id, once known; asking for an unknown one starts loading it. */
export type RecipeTitleOf = (recipeId: string) => string | undefined;

/**
 * Recipe titles for the meal drafts. A draft holds only the recipe's id (the model picks a
 * handle from the recipe list); the card shows the recipe's own, current title, read once
 * through the kitchen's API. The map is reactive, so a card that asked shows the title as soon
 * as it arrives; until then (or without access to the kitchen) it reads "A saved recipe".
 */
export function recipeTitles(load: (recipeId: string) => Promise<string>): RecipeTitleOf {
	const titles = new SvelteMap<string, string>();
	const asked = new Set<string>();
	return (recipeId) => {
		const known = titles.get(recipeId);
		if (known !== undefined || asked.has(recipeId)) return known;
		asked.add(recipeId);
		// Started from a card's render: the map changes only after the load, never during it.
		load(recipeId).then(
			(title) => titles.set(recipeId, title),
			() => {},
		);
		return undefined;
	};
}

/** The draft card's title: what is cooked (the recipe's title, or the written dish). */
export function mealTitle(
	input: AddToMealPlanInput,
	c: PresenterContext,
	recipeTitle: RecipeTitleOf,
): string {
	if (input.title) return input.title;
	return (input.recipeId && recipeTitle(input.recipeId)) || c.t('kitchen:draft_recipe_chosen');
}

/** One row for when: "Saturday 10 October · Dinner", in the family's format locale. */
export function mealFields(input: AddToMealPlanInput, c: PresenterContext): DraftField[] {
	return [
		{
			label: c.t('kitchen:draft_when'),
			value: [draftDate(input.date, c), c.t(`kitchen:slot_${input.slot ?? 'dinner'}`)]
				.filter(Boolean)
				.join(' · '),
			paths: ['date', 'slot'],
		},
		...(input.note ? [{ label: c.t('kitchen:draft_notes'), value: input.note, path: 'note' }] : []),
	];
}
