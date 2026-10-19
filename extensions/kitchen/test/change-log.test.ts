import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MealEntry, Recipe } from '../src/contract/index.ts';
import { applied, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	k = await createKernel();
	admin = await person(k, 'admin', 'Ayşe');
});
afterEach(() => k.close());

const pairs = async (since = 0) =>
	(await k.changes.since(since, admin.actor)).changes.map((c) => [c.entity, c.id, c.op]);

describe('the kitchen in the change log', () => {
	it('names the recipe and the meal that changed, not just the area', async () => {
		const recipe = await applied<Recipe>(
			k,
			'kitchen.createRecipe',
			{ title: 'Soup', servings: '4', ingredients: ['1 onion'], steps: ['Simmer.'], tags: [] },
			admin.actor,
		);
		const meal = await applied<MealEntry>(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-07', title: 'Pasta' },
			admin.actor,
		);
		expect(await pairs()).toEqual([
			['recipe', recipe.id, 'upsert'],
			['meal', meal.id, 'upsert'],
		]);
	});

	it('leaves a tombstone for an archived recipe and a meal taken off the plan', async () => {
		const recipe = await applied<Recipe>(
			k,
			'kitchen.createRecipe',
			{ title: 'Soup', servings: '4', ingredients: ['1 onion'], steps: ['Simmer.'], tags: [] },
			admin.actor,
		);
		const meal = await applied<MealEntry>(
			k,
			'kitchen.addToMealPlan',
			{ date: '2026-10-07', title: 'Pasta' },
			admin.actor,
		);
		await applied(k, 'kitchen.archiveRecipe', { id: recipe.id }, admin.actor);
		await applied(k, 'kitchen.removeMealPlanEntry', { id: meal.id }, admin.actor);
		expect(await pairs()).toEqual([
			['recipe', recipe.id, 'delete'],
			['meal', meal.id, 'delete'],
		]);
	});
});
