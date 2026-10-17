import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { kitchenChanged, kitchenEdit, kitchenView } from './capabilities.ts';
import {
	addToMealPlan,
	aiMealPlan,
	getMealPlan,
	removeMealPlanEntry,
	updateMealPlanEntry,
} from './meal-plan.ts';
import {
	aiListRecipes,
	archiveRecipe,
	createRecipe,
	getRecipe,
	getRecipePhoto,
	searchRecipesRoute,
	setRecipePhoto,
	updateRecipe,
	uploadRecipePhoto,
} from './recipes.ts';
import { searchIndex } from './search.ts';
import { addIngredientsToShopping } from './shopping.ts';
import { migrations } from './store.ts';
import { mealKind, mealOffKind, recipeKind } from './understand.ts';

/**
 * Kitchen: recipes (typed in, or proposed by the AI from the Inbox), a weekly meal plan and
 * "ingredients to the shopping list". Ingredients are free text lines; on the way to the shopping
 * list the amount is read off as the quantity, nothing is converted. It reaches the shopping list only through the `lists` action, never its tables.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { index: searchIndex, kinds: [recipeKind, mealKind, mealOffKind] },
	actions: [
		createRecipe,
		updateRecipe,
		archiveRecipe,
		setRecipePhoto,
		addToMealPlan,
		updateMealPlanEntry,
		removeMealPlanEntry,
		addIngredientsToShopping,
		aiListRecipes,
		aiMealPlan,
	],
	routes: [searchRecipesRoute, getRecipe, getRecipePhoto, uploadRecipePhoto, getMealPlan],
	events: [kitchenChanged],
	capabilities: [kitchenView, kitchenEdit],
});
