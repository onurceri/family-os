import { defineWebExtension } from '@famos/ui/slots';
import { UtensilsCrossed } from '@lucide/svelte';
import {
	addToMealPlanPresenter,
	createRecipePresenter,
	removeMealPlanEntryPresenter,
} from './presenters.js';
import { kitchenTimeline } from './timeline.js';

/**
 * Kitchen UI: recipes and the weekly meal plan under `/kitchen`, today's meals on the Today timeline,
 * and the Inbox presenters for recipes and meals.
 */
export default defineWebExtension({
	id: 'kitchen',
	labelKey: 'kitchen:feature_name',
	descriptionKey: 'kitchen:feature_description',
	nav: [
		{
			id: 'kitchen.nav',
			path: '/kitchen',
			labelKey: 'kitchen:nav',
			icon: UtensilsCrossed,
			placement: 'more',
			group: 'household',
			order: 50,
			requires: 'kitchen.view',
		},
	],
	pages: [
		// One component for the recipes and a recipe, so opening one keeps the list mounted (read once).
		{ id: 'kitchen.page', path: '/kitchen', component: () => import('./RecipePage.svelte') },
		{ id: 'kitchen.plan', path: '/kitchen/plan', component: () => import('./PlanPage.svelte') },
		{
			id: 'kitchen.recipe',
			path: '/kitchen/recipes/:id',
			component: () => import('./RecipePage.svelte'),
		},
	],
	timeline: [kitchenTimeline],
	drafts: [createRecipePresenter, addToMealPlanPresenter, removeMealPlanEntryPresenter],
});
