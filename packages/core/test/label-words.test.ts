import { labelNamesTitle, namedShares, significantWords } from '@famos/sdk';
import { describe, expect, it } from 'vitest';

describe('namedShares', () => {
	const vet =
		"Call the Riverside Vet Clinic to move Bruno's check-up, ask whether the booster can be done at the same visit, and bring the passports";

	it('picks the item the text names, not one that shares a word or common words', () => {
		// Found in use: a long task repeating "the" outscored the picture wire by word count.
		const [wire = 0, hooks = 0, task = 0] = namedShares(
			'Got the picture wire already, tick it off',
			['Picture wire', 'Picture hooks', vet],
		);
		expect(wire).toBe(1);
		expect(hooks).toBeGreaterThan(0);
		expect(hooks).toBeLessThan(wire);
		expect(task).toBeLessThan(hooks);
	});

	it('still names a task the text words differently', () => {
		const [fee = 0, dentist = 0] = namedShares('I paid the swim course fee', [
			'Pay the swim course fee',
			'Book the dentist',
		]);
		expect(fee).toBeGreaterThan(dentist);
		expect(fee).toBeGreaterThan(0.5);
	});

	it('works in any language and for titles without a significant word', () => {
		expect(namedShares('Süt aldım', ['Yulaf sütü'])).toEqual([0]);
		expect(namedShares('Buy 4 of them', ['4'])).toEqual([1]);
		expect(namedShares('Buy five', ['4'])).toEqual([0]);
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
