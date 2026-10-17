import { unwrap } from '@famos/api-client';
import type { ShoppingList } from '@famos/ext-lists/contract';
import type {
	AddToMealPlanInput,
	MealEntry,
	Recipe,
	RecipeFields,
	RecipeReplace,
	RecipeSummary,
} from '../contract/index.js';
import { api } from './api.js';
import type { ShoppingOutcome } from './shopping-summary.js';

/** Kitchen API calls, all through the generated client. */
export type Outcome = 'applied' | 'drafted';

export const loadRecipes = async (q?: string, tag?: string): Promise<RecipeSummary[]> =>
	unwrap(
		await api.GET('/api/v1/kitchen/recipes', {
			params: { query: { ...(q && { q }), ...(tag && { tag }) } },
		}),
	);

export const loadRecipe = async (recipeId: string): Promise<Recipe> =>
	unwrap(await api.GET('/api/v1/kitchen/recipes/{recipeId}', { params: { path: { recipeId } } }));

export const recipePhotoUrl = (recipeId: string, version: number) =>
	`/api/v1/kitchen/recipes/${recipeId}/photo?v=${version}`;

export async function createRecipe(
	recipe: RecipeFields,
): Promise<{ outcome: Outcome; id: string | null }> {
	const result = unwrap(await api.POST('/api/v1/actions/kitchen.createRecipe', { body: recipe }));
	return { outcome: result.status, id: result.status === 'applied' ? result.output.id : null };
}

export async function updateRecipe(id: string, recipe: RecipeReplace): Promise<Outcome> {
	return unwrap(await api.POST('/api/v1/actions/kitchen.updateRecipe', { body: { id, recipe } }))
		.status;
}

export const archiveRecipe = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/kitchen.archiveRecipe', { body: { id } })).status;

export async function uploadPhoto(recipeId: string, file: File): Promise<void> {
	unwrap(
		await api.POST('/api/v1/kitchen/recipes/{recipeId}/photo', {
			params: { path: { recipeId } },
			body: {},
			bodySerializer: () => {
				const form = new FormData();
				form.append('files', file, file.name);
				return form;
			},
		}),
	);
}

/** Puts the chosen ingredient lines on a shopping list; says what was new and what was not. */
export async function addToShopping(
	recipeId: string,
	lines: string[],
	listId?: string,
): Promise<ShoppingOutcome> {
	const result = unwrap(
		await api.POST('/api/v1/actions/kitchen.addIngredientsToShopping', {
			body: { recipeId, lines, ...(listId && { listId }) },
		}),
	);
	if (result.status !== 'applied')
		return { added: 0, alreadyThere: 0, existing: [], unknownLines: [] };
	return result.output;
}

export const loadShoppingLists = async (): Promise<ShoppingList[]> =>
	unwrap(await api.GET('/api/v1/lists/shopping/lists'));

export const loadMeals = async (from: string, to: string): Promise<MealEntry[]> =>
	unwrap(await api.GET('/api/v1/kitchen/meal-plan', { params: { query: { from, to } } }));

export const addMeal = async (input: AddToMealPlanInput): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/kitchen.addToMealPlan', { body: input })).status;

export const removeMeal = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/kitchen.removeMealPlanEntry', { body: { id } })).status;
