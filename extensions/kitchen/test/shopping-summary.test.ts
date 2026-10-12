import { describe, expect, it } from 'vitest';
import { shoppingSummary } from '../src/web/shopping-summary.ts';

/** Shows each key with its options, so the test reads what the page would pass. */
const t = (key: string, options?: Record<string, unknown>) =>
	options ? `${key} ${JSON.stringify(options)}` : key;

describe('shoppingSummary', () => {
	it('says what was added, what was already there and what was not added', () => {
		const summary = shoppingSummary(
			{
				added: 2,
				alreadyThere: 2,
				existing: [
					{ title: 'Chicken breast', listQuantity: '500 g', recipeQuantity: '600 g' },
					{ title: 'Onion', listQuantity: '1', recipeQuantity: '1' },
				],
				unknownLines: ['a line someone made up'],
			},
			t,
		);
		expect(summary.headline).toBe(
			[
				'shopping_added {"count":2}',
				'shopping_already_count {"count":2}',
				'shopping_not_added_count {"count":1}',
			].join('. '),
		);
		expect(summary.details).toEqual([
			'shopping_already_differs {"title":"Chicken breast","list":"500 g","recipe":"600 g"}',
			'shopping_already {"title":"Onion"}',
			'shopping_not_added {"line":"a line someone made up"}',
		]);
	});

	it('says everything was there already when nothing was new', () => {
		const summary = shoppingSummary(
			{
				added: 0,
				alreadyThere: 1,
				existing: [{ title: 'Onion', listQuantity: null, recipeQuantity: '1' }],
				unknownLines: [],
			},
			t,
		);
		expect(summary.headline).toBe('shopping_nothing_new');
		expect(summary.details).toEqual(['shopping_already {"title":"Onion"}']);
	});
});
