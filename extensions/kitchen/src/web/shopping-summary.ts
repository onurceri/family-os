/** What putting a recipe's ingredients on the shopping list did, as the page tells it. */
export interface ShoppingOutcome {
	added: number;
	alreadyThere: number;
	existing: { title: string; listQuantity: string | null; recipeQuantity: string | null }[];
	unknownLines: string[];
}

/** The kitchen's keys the summary uses. */
export type SummaryKey =
	| 'shopping_added'
	| 'shopping_nothing_new'
	| 'shopping_already_count'
	| 'shopping_not_added_count'
	| 'shopping_already'
	| 'shopping_already_differs'
	| 'shopping_not_added';

/** The kitchen translator, seen as far as the summary needs it. */
export type SummaryT = (key: SummaryKey, options?: Record<string, unknown>) => string;

/**
 * The toast's sentence and the detail lines under the ingredients: how many were added, which
 * items were already on the list (with the list's quantity and the recipe's when they differ),
 * and which lines were not added at all.
 */
export function shoppingSummary(
	result: ShoppingOutcome,
	t: SummaryT,
): { headline: string; details: string[] } {
	const parts: string[] = [];
	if (result.added > 0) parts.push(t('shopping_added', { count: result.added }));
	else if (result.alreadyThere > 0 && result.unknownLines.length === 0)
		parts.push(t('shopping_nothing_new'));
	if (result.alreadyThere > 0 && result.added > 0)
		parts.push(t('shopping_already_count', { count: result.alreadyThere }));
	if (result.unknownLines.length > 0)
		parts.push(t('shopping_not_added_count', { count: result.unknownLines.length }));

	const details = [
		...result.existing.map((item) => {
			const list = item.listQuantity?.trim();
			const recipe = item.recipeQuantity?.trim();
			if (list && recipe && list !== recipe)
				return t('shopping_already_differs', { title: item.title, list, recipe });
			return t('shopping_already', { title: item.title });
		}),
		...result.unknownLines.map((line) => t('shopping_not_added', { line })),
	];
	return { headline: parts.join('. '), details };
}
