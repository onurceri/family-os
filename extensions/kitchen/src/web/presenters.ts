import { type DraftPresenter, removalPresenter } from '@famos/ui/slots';
import { CalendarDays, CookingPot } from '@lucide/svelte';
import type { AddToMealPlanInput, CreateRecipeInput } from '../contract/index.js';
import { loadRecipe } from './data.js';
import { mealFields, mealTitle, recipeTitles } from './meal-draft.js';

const recipeTitle = recipeTitles(async (id) => (await loadRecipe(id)).title);

/** How a suggested recipe reads in the Inbox. */
export const createRecipePresenter: DraftPresenter<CreateRecipeInput> = {
	actionId: 'kitchen.createRecipe',
	kind: (c) => c.t('kitchen:kind_recipe'),
	icon: CookingPot,
	title: (input) => input.title,
	fields: (input, c) => [
		...(input.servings
			? [{ label: c.t('kitchen:draft_servings'), value: input.servings, path: 'servings' }]
			: []),
		...(input.totalMinutes
			? [
					{
						label: c.t('kitchen:draft_minutes'),
						value: c.t('kitchen:minutes_long', { count: input.totalMinutes }),
						path: 'totalMinutes',
					},
				]
			: []),
		...(input.ingredients?.length
			? [
					{
						label: c.t('kitchen:draft_ingredients'),
						value: input.ingredients.join(', '),
						path: 'ingredients',
					},
				]
			: []),
		...(input.steps?.length
			? [
					{
						label: c.t('kitchen:draft_steps'),
						value: c.t('kitchen:draft_steps_count', { count: input.steps.length }),
						path: 'steps',
					},
				]
			: []),
		...(input.sourceUrl
			? [
					{
						label: c.t('kitchen:draft_source'),
						value: hostOf(input.sourceUrl),
						path: 'sourceUrl',
					},
				]
			: []),
	],
	approveLabel: (c) => c.t('kitchen:draft_approve_recipe'),
};

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/** A meal for the plan: the recipe's own title, and the day in the family's formats. */
export const addToMealPlanPresenter: DraftPresenter<AddToMealPlanInput> = {
	actionId: 'kitchen.addToMealPlan',
	kind: (c) => c.t('kitchen:kind_meal'),
	icon: CalendarDays,
	title: (input, c) => mealTitle(input, c, recipeTitle),
	fields: mealFields,
	approveLabel: (c) => c.t('kitchen:draft_approve_meal'),
};

/** A proposal to take a planned meal off the plan; its label names the meal and its day. */
export const removeMealPlanEntryPresenter: DraftPresenter<{ id: string; label?: string }> = {
	actionId: 'kitchen.removeMealPlanEntry',
	removes: true,
	kind: (c) => c.t('kitchen:kind_meal'),
	icon: CalendarDays,
	title: (input, c) => input.label || c.t('kitchen:draft_a_meal'),
	fields: () => [],
	approveLabel: (c) => c.t('kitchen:draft_approve_remove_meal'),
};

/** A suggestion to archive a recipe: its page says it would be removed. */
export const archiveRecipePresenter = removalPresenter({
	actionId: 'kitchen.archiveRecipe',
	kindKey: 'kitchen:kind_recipe',
	titleKey: 'kitchen:draft_title_archive_recipe',
	icon: CookingPot,
});
