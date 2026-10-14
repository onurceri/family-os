import { defineWebExtension } from '@famos/ui/slots';
import { UtensilsCrossed } from '@lucide/svelte';
import {
	addToMealPlanPresenter,
	createRecipePresenter,
	removeMealPlanEntryPresenter,
} from './presenters.js';
import { kitchenTimeline } from './timeline.js';

/**
 * Kitchen UI: recipes and the weekly meal plan under `/kitchen`, today's meals on the Today timeline
 * (and as a block of their own), and the Inbox presenters for recipes and meals.
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
	blocks: [
		{
			// The block's id is the one people have hidden it by since it was the app's own.
			id: 'kitchen',
			labelKey: 'kitchen:today_block',
			hintKey: 'kitchen:today_block_hint',
			titleKey: 'kitchen:today_meals_title',
			// Today's meals as a list of their own, between Needs you (90) and the next days (110).
			items: 'meal',
			order: 100,
		},
	],
	drafts: [createRecipePresenter, addToMealPlanPresenter, removeMealPlanEntryPresenter],
});
