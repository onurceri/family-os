import { repoTranslate } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { longestTitle, parseQuickAdd } from '../src/web/quick-add.ts';

/** The units of the English catalog and of the bundled Turkish pack, as the page reads them. */
const translate = repoTranslate();
const units = (locale: string) => translate(locale, 'lists:quantity_units').split(',');
const en = units('en');
const tr = units('tr');

describe('parseQuickAdd', () => {
	it('splits items and takes a leading amount as the quantity', () => {
		expect(parseQuickAdd('2 kg domates, ekmek;  1,5 L süt\n3 yumurta', tr)).toEqual([
			{ title: 'domates', quantity: '2 kg' },
			{ title: 'ekmek' },
			{ title: 'süt', quantity: '1,5 L' },
			{ title: 'yumurta', quantity: '3' },
		]);
	});

	it('reads imperial and US units as quantities', () => {
		expect(
			parseQuickAdd(
				'2 lb flour, 1 gal milk; 12 oz cheese\n1 dozen eggs, 3 cans tomatoes, 2 bottles water, 1 pack bacon, 6 pcs rolls',
				en,
			),
		).toEqual([
			{ title: 'flour', quantity: '2 lb' },
			{ title: 'milk', quantity: '1 gal' },
			{ title: 'cheese', quantity: '12 oz' },
			{ title: 'eggs', quantity: '1 dozen' },
			{ title: 'tomatoes', quantity: '3 cans' },
			{ title: 'water', quantity: '2 bottles' },
			{ title: 'bacon', quantity: '1 pack' },
			{ title: 'rolls', quantity: '6 pcs' },
		]);
		expect(parseQuickAdd('2 lbs. rice, 1 qt cream, 2 pt berries, 1 doz rolls', en)).toEqual([
			{ title: 'rice', quantity: '2 lbs.' },
			{ title: 'cream', quantity: '1 qt' },
			{ title: 'berries', quantity: '2 pt' },
			{ title: 'rolls', quantity: '1 doz' },
		]);
	});

	it('attaches a part that is only an amount to the item before it', () => {
		expect(parseQuickAdd('Picture hooks, 4', en)).toEqual([
			{ title: 'Picture hooks', quantity: '4' },
		]);
		expect(parseQuickAdd('Rice, 2 kg, bread, 3', en)).toEqual([
			{ title: 'Rice', quantity: '2 kg' },
			{ title: 'bread', quantity: '3' },
		]);
		// The item before already has an amount: the lone number stays its own entry.
		expect(parseQuickAdd('2 kg rice, 3', en)).toEqual([
			{ title: 'rice', quantity: '2 kg' },
			{ title: '3' },
		]);
	});

	it('reads an amount with a unit at the end', () => {
		expect(parseQuickAdd('Parmesan 150 g, milk 2 lb', en)).toEqual([
			{ title: 'Parmesan', quantity: '150 g' },
			{ title: 'milk', quantity: '2 lb' },
		]);
		expect(parseQuickAdd('iPhone 15', en)).toEqual([{ title: 'iPhone 15' }]);
	});

	it('keeps numbers that are part of the name', () => {
		expect(parseQuickAdd('7up', en)).toEqual([{ title: '7up' }]);
		expect(parseQuickAdd(' , ,', en)).toEqual([]);
	});
});

describe('longestTitle', () => {
	it('measures the longest item, not the whole text, and leaves the amount out', () => {
		const long = 'x'.repeat(130);
		expect(longestTitle(`2 kg tomatoes, ${long}, bread`, en)).toBe(long);
		expect(longestTitle('milk, 4', en)).toBe('milk');
		expect(longestTitle('', en)).toBe('');
	});
});
