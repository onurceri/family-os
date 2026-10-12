import { labelNamesTitle, significantWords, textNamesTitle } from '@famos/sdk';
import { describe, expect, it } from 'vitest';

describe('textNamesTitle', () => {
	it('needs every significant word of the title in the text, in any order', () => {
		expect(textNamesTitle('Got the E27 light bulbs', 'Light bulbs E27')).toBe(true);
		expect(textNamesTitle('Got the picture wire already', 'Picture hooks')).toBe(false);
		expect(textNamesTitle('Got the picture wire already', 'Picture wire')).toBe(true);
	});

	it('ignores a trailing plural s and the case', () => {
		expect(textNamesTitle('GOT THE LIGHT BULB', 'light bulbs')).toBe(true);
	});

	it('works for any language and ignores bracketed notes in the title', () => {
		expect(textNamesTitle('Faturaları öde', 'Faturaları öde (Ekim)')).toBe(true);
		expect(textNamesTitle('Süt aldım', 'Yulaf sütü')).toBe(false);
	});

	it('looks for a title without significant words as written', () => {
		expect(textNamesTitle('Buy 4 of them', '4')).toBe(true);
		expect(textNamesTitle('Buy five', '4')).toBe(false);
	});
});

describe('significantWords', () => {
	it('keeps letters and digits of three or more characters, lower case', () => {
		expect(significantWords('Oat Milk, 2L!')).toEqual(['oat', 'milk']);
	});

	it('ignores numbers, short words and anything in brackets', () => {
		expect(significantWords('Dentist (14 Oct) [room 4] at 10')).toEqual(['dentist']);
		expect(significantWords('4')).toEqual([]);
	});

	it('works for any script, without knowing a language', () => {
		expect(significantWords('Faturaları öde')).toEqual(['faturaları', 'öde']);
	});
});

describe('labelNamesTitle', () => {
	it('needs every significant word of the label as a whole word of the title', () => {
		expect(labelNamesTitle('Dental cleaning', 'Dentist checkup')).toBe(false);
		expect(labelNamesTitle('Delft board meeting', 'Delft project call')).toBe(false);
		expect(labelNamesTitle('anchovies', 'Olive oil')).toBe(false);
		expect(labelNamesTitle('Milk', 'Oat milk')).toBe(true);
		expect(labelNamesTitle('Oat milk', 'Oat milk')).toBe(true);
		// Not a part of a word.
		expect(labelNamesTitle('dent', 'Dentist checkup')).toBe(false);
	});

	it('also accepts a label that holds the whole title, like a leading article', () => {
		expect(labelNamesTitle('the bread', 'Bread')).toBe(true);
		expect(labelNamesTitle('milk', 'Oat milk')).toBe(true);
		expect(labelNamesTitle('Dentist checkup tomorrow', 'Dentist checkup')).toBe(true);
		expect(labelNamesTitle('the Delft board meeting', 'Delft project call')).toBe(false);
		expect(labelNamesTitle('4', '4')).toBe(true);
	});

	it('ignores case, spacing, brackets and a trailing plural s', () => {
		expect(labelNamesTitle('  DENTIST   checkups (14 Oct) ', 'Dentist checkup')).toBe(true);
		expect(labelNamesTitle('Dentist checkup', 'Dentist checkups')).toBe(true);
	});

	it('refuses a label without a significant word unless it is the title', () => {
		expect(labelNamesTitle('4', 'Oat milk')).toBe(false);
		expect(labelNamesTitle('4', '4')).toBe(true);
		expect(labelNamesTitle('  ', 'Oat milk')).toBe(false);
	});
});
