import { repoVocabulary } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { type IngredientWords, ingredientToItem } from '../src/server/ingredient.ts';

/** The words of English and the bundled packs, as the action reads them. */
const vocabulary = repoVocabulary();
const words: IngredientWords = {
	units: [...vocabulary('lists:quantity_units'), ...vocabulary('kitchen:words_units')],
	links: vocabulary('kitchen:words_amount_link'),
	preparation: vocabulary('kitchen:words_preparation'),
};
const en = (line: string) => ingredientToItem(line, words, 'en');
const tr = (line: string) => ingredientToItem(line, words, 'tr');

describe('ingredientToItem', () => {
	it('takes the amount as the quantity and the product as a capitalised title', () => {
		expect(en('2 tbsp olive oil')).toEqual({ title: 'Olive oil', quantity: '2 tbsp' });
		expect(en('4 eggs')).toEqual({ title: 'Eggs', quantity: '4' });
		expect(en('500g flour')).toEqual({ title: 'Flour', quantity: '500g' });
		expect(en('2 cups of rice')).toEqual({ title: 'Rice', quantity: '2 cups' });
	});

	it('moves an amount in brackets into the quantity', () => {
		expect(en('1 tin chopped tomatoes (400 g)')).toEqual({
			title: 'Chopped tomatoes',
			quantity: '1 tin (400 g)',
		});
		expect(en('Chopped tomatoes (400 g)')).toEqual({
			title: 'Chopped tomatoes',
			quantity: '400 g',
		});
		expect(en('1 lemon (optional)')).toEqual({ title: 'Lemon', quantity: '1' });
	});

	it('drops the notes that say how to use the product', () => {
		expect(en('Lemon, zest and juice')).toEqual({ title: 'Lemon' });
		expect(en('2 limes, juice only')).toEqual({ title: 'Limes', quantity: '2' });
		expect(en('Butter, plus extra for the pan')).toEqual({ title: 'Butter' });
		expect(en('Chicken breast, 500 g, skinned')).toEqual({
			title: 'Chicken breast',
			quantity: '500 g',
		});
		expect(tr('Limon, kabuğu ve suyu')).toEqual({ title: 'Limon' });
	});

	it('drops a preparation note after a comma', () => {
		expect(en('60 g feta, crumbled')).toEqual({ title: 'Feta', quantity: '60 g' });
		expect(en('1 onion, finely chopped')).toEqual({ title: 'Onion', quantity: '1' });
		expect(en('Salt, to taste')).toEqual({ title: 'Salt' });
		expect(en('salt, pepper')).toEqual({ title: 'Salt, pepper' });
		expect(en('1,5 kg potatoes, peeled')).toEqual({ title: 'Potatoes', quantity: '1,5 kg' });
	});

	it('drops the preparation words that were missing, and reads a lone amount as the quantity', () => {
		expect(en('Lemon, juiced')).toEqual({ title: 'Lemon' });
		expect(en('2 red onions, cut in wedges')).toEqual({ title: 'Red onions', quantity: '2' });
		expect(en('1 chicken breast, boneless')).toEqual({ title: 'Chicken breast', quantity: '1' });
		expect(en('Lime, 1')).toEqual({ title: 'Lime', quantity: '1' });
		expect(en('Flour, 2 cups')).toEqual({ title: 'Flour', quantity: '2 cups' });
		expect(tr('Limon, suyu sıkılmış')).toEqual({ title: 'Limon' });
	});

	it('reads a line without an amount as all title', () => {
		expect(en('fresh parsley')).toEqual({ title: 'Fresh parsley' });
		expect(en('  ')).toBeNull();
	});

	it('reads fractions and ranges', () => {
		expect(en('½ cup milk')).toEqual({ title: 'Milk', quantity: '½ cup' });
		expect(en('1½ tsp salt')).toEqual({ title: 'Salt', quantity: '1½ tsp' });
		expect(en('1 1/2 cups sugar')).toEqual({ title: 'Sugar', quantity: '1 1/2 cups' });
		expect(en('2-3 cloves garlic')).toEqual({ title: 'Garlic', quantity: '2-3 cloves' });
	});

	it('reads Turkish lines with Turkish units and capital letters', () => {
		expect(tr('2 yemek kaşığı zeytinyağı')).toEqual({
			title: 'Zeytinyağı',
			quantity: '2 yemek kaşığı',
		});
		expect(tr('1 adet soğan, ince doğranmış')).toEqual({ title: 'Soğan', quantity: '1 adet' });
		expect(tr('200 g ıspanak')).toEqual({ title: 'Ispanak', quantity: '200 g' });
		expect(tr('3 diş sarımsak, ezilmiş')).toEqual({ title: 'Sarımsak', quantity: '3 diş' });
		expect(tr('incir')).toEqual({ title: 'İncir' });
	});
});
