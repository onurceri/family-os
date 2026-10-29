import { repoTranslate } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { capitalize, listEntry } from '../src/contract/index.ts';
import { longestTitle, parseQuickAdd } from '../src/web/quick-add.ts';

/** The units of the English catalog and of the bundled Turkish pack, as the page reads them. */
const translate = repoTranslate();
const units = (locale: string) => translate(locale, 'lists:quantity_units').split(',');
const en = units('en');
const tr = units('tr');

describe('parseQuickAdd', () => {
	it("reads a number and a unit after an item as that item's quantity", () => {
		expect(parseQuickAdd('Sandpaper, 2 sheets', en)).toEqual([
			{ title: 'Sandpaper', quantity: '2 sheets' },
		]);
		expect(parseQuickAdd('Bread, 2 bags, 3 litres milk', en)).toEqual([
			{ title: 'Bread', quantity: '2 bags' },
			{ title: 'milk', quantity: '3 litres' },
		]);
		expect(parseQuickAdd('Zımpara, 2 tabaka', tr)).toEqual([
			{ title: 'Zımpara', quantity: '2 tabaka' },
		]);
	});

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

describe('every item a list entry', () => {
	it('starts every title with a capital, with an amount or without', () => {
		expect(parseQuickAdd('2 kg tomatoes, bread', en, 'en')).toEqual([
			{ title: 'Tomatoes', quantity: '2 kg' },
			{ title: 'Bread' },
		]);
		expect(parseQuickAdd('2 L oat milk, bread, parmesan 150 g, hooks, 4', en, 'en')).toEqual([
			{ title: 'Oat milk', quantity: '2 L' },
			{ title: 'Bread' },
			{ title: 'Parmesan', quantity: '150 g' },
			{ title: 'Hooks', quantity: '4' },
		]);
	});

	it('keeps a name that writes its own capitals', () => {
		expect(parseQuickAdd('iPhone charger, eBay parcel, 7up', en, 'en')).toEqual([
			{ title: 'iPhone charger' },
			{ title: 'eBay parcel' },
			{ title: '7up' },
		]);
		expect(listEntry('oat MILK', 'en')).toBe('Oat MILK');
	});

	it('follows the rule of the language: the Turkish dotted I', () => {
		expect(parseQuickAdd('2 kg iğde, 1 L ılık süt, ekmek', tr, 'tr')).toEqual([
			{ title: 'İğde', quantity: '2 kg' },
			{ title: 'Ilık süt', quantity: '1 L' },
			{ title: 'Ekmek' },
		]);
		expect(parseQuickAdd('2 kg iğde', tr, 'en')).toEqual([{ title: 'Iğde', quantity: '2 kg' }]);
	});

	it('leaves a title alone when no language is given', () => {
		expect(parseQuickAdd('2 L oat milk', en)).toEqual([{ title: 'oat milk', quantity: '2 L' }]);
	});

	it('changes only the first letter', () => {
		expect(capitalize('oat MILK', 'en')).toBe('Oat MILK');
		expect(capitalize('', 'en')).toBe('');
		expect(capitalize('\u{1F95B} milk', 'en')).toBe('\u{1F95B} milk');
	});
});

describe('the preview of several items', () => {
	it('counts the same items Enter adds, so the two cannot disagree', () => {
		const items = parseQuickAdd('vanilla yoghurt, a large tub of it, 1,5 kg rice', en, 'en');
		expect(items.map((i) => i.title)).toEqual(['Vanilla yoghurt', 'A large tub of it', 'Rice']);
		expect(parseQuickAdd('2 kg tomatoes', en, 'en')).toHaveLength(1);
	});
});
