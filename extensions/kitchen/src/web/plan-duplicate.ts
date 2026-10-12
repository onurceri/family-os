import type { MealEntry, MealSlot } from '../contract/index.js';

/**
 * The meal already planned for that day and meal that a new one would repeat: the same recipe, or
 * for a written dish the same words (case and spacing aside). Undefined when there is none.
 */
export function plannedAlready(
	meals: readonly MealEntry[],
	wanted: { date: string; slot: MealSlot; recipeId?: string; title?: string },
	locale: string,
): MealEntry | undefined {
	const same = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase(locale);
	const title = wanted.title ? same(wanted.title) : '';
	return meals.find(
		(m) =>
			m.date === wanted.date &&
			m.slot === wanted.slot &&
			(wanted.recipeId
				? m.recipeId === wanted.recipeId
				: !m.recipeId && title && same(m.title) === title),
	);
}
