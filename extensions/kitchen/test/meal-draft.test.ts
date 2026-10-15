import type { PresenterContext } from '@famos/ui/slots';
import { describe, expect, it, vi } from 'vitest';
import { mealFields, mealTitle, recipeTitles } from '../src/web/meal-draft.ts';

const words: Record<string, string> = {
	'kitchen:draft_recipe_chosen': 'A saved recipe',
	'kitchen:draft_when': 'When',
	'kitchen:draft_notes': 'Notes',
	'kitchen:slot_dinner': 'Dinner',
	'kitchen:slot_lunch': 'Lunch',
};
const context = (locale: string): PresenterContext => ({
	t: (key) => words[key] ?? key,
	members: [],
	formatLocale: locale,
	dateLocale: locale,
	weekStart: 1,
	hourCycle: 'h23',
	timeZone: 'UTC',
});
const c = context('en-GB');

describe('the meal draft card', () => {
	it('shows the day in the family format locale with the meal', () => {
		expect(mealFields({ date: '2026-10-10', slot: 'dinner' }, c)).toEqual([
			{ label: 'When', value: 'Saturday 10 October · Dinner', paths: ['date', 'slot'] },
		]);
		expect(mealFields({ date: '2026-10-10', slot: 'lunch' }, context('en-US'))[0]?.value).toBe(
			'Saturday, October 10 · Lunch',
		);
	});

	it('defaults to dinner and keeps a note', () => {
		const fields = mealFields({ date: '2026-10-10', note: 'Double it' }, c);
		expect(fields.map((f) => f.value)).toEqual(['Saturday 10 October · Dinner', 'Double it']);
	});

	it("shows the recipe's own title once it is loaded", async () => {
		const load = vi.fn(async () => 'Lentil soup');
		const titleOf = recipeTitles(load);
		const input = { date: '2026-10-10', recipeId: 'kit_recipe_1' };
		expect(mealTitle(input, c, titleOf)).toBe('A saved recipe');
		await vi.waitFor(() => expect(mealTitle(input, c, titleOf)).toBe('Lentil soup'));
		mealTitle(input, c, titleOf);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('asks once and keeps the fallback when the recipe cannot be read', async () => {
		const load = vi.fn(async () => {
			throw new Error('forbidden');
		});
		const titleOf = recipeTitles(load);
		const input = { date: '2026-10-10', recipeId: 'kit_recipe_2' };
		expect(mealTitle(input, c, titleOf)).toBe('A saved recipe');
		await Promise.resolve();
		expect(mealTitle(input, c, titleOf)).toBe('A saved recipe');
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('shows a written dish as written', () => {
		const load = vi.fn(async () => 'never');
		expect(mealTitle({ date: '2026-10-10', title: 'Pancakes' }, c, recipeTitles(load))).toBe(
			'Pancakes',
		);
		expect(load).not.toHaveBeenCalled();
	});
});
