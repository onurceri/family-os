import { describe, expect, it } from 'vitest';
import type { MealEntry } from '../src/contract/index.ts';
import { plannedAlready } from '../src/web/plan-duplicate.ts';

const meal = (over: Partial<MealEntry>): MealEntry => ({
	id: 'meal_1',
	date: '2026-10-18',
	slot: 'dinner',
	recipeId: null,
	title: 'Dutch pancakes',
	note: null,
	createdAt: 0,
	...over,
});

describe('plannedAlready', () => {
	const meals = [
		meal({ recipeId: 'recipe_1' }),
		meal({ id: 'meal_2', title: 'Leftover   soup' }),
		meal({ id: 'meal_3', slot: 'lunch', recipeId: 'recipe_2', title: 'Salad' }),
	];

	it('finds the same recipe in the same meal on the same day', () => {
		const found = plannedAlready(
			meals,
			{ date: '2026-10-18', slot: 'dinner', recipeId: 'recipe_1' },
			'en',
		);
		expect(found?.id).toBe('meal_1');
	});

	it('finds a written dish by its words, ignoring case and spacing', () => {
		expect(
			plannedAlready(meals, { date: '2026-10-18', slot: 'dinner', title: ' leftover soup ' }, 'en')
				?.id,
		).toBe('meal_2');
	});

	it('finds nothing for another meal, another day, or another dish', () => {
		expect(
			plannedAlready(meals, { date: '2026-10-18', slot: 'lunch', recipeId: 'recipe_1' }, 'en'),
		).toBeUndefined();
		expect(
			plannedAlready(meals, { date: '2026-10-19', slot: 'dinner', recipeId: 'recipe_1' }, 'en'),
		).toBeUndefined();
		expect(
			plannedAlready(meals, { date: '2026-10-18', slot: 'dinner', recipeId: 'recipe_9' }, 'en'),
		).toBeUndefined();
		expect(
			plannedAlready(meals, { date: '2026-10-18', slot: 'dinner', title: '' }, 'en'),
		).toBeUndefined();
	});
});
