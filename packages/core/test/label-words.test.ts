import { compareThing, namedShares, namesThing, searchFinds, significantWords } from '@famos/sdk';
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

describe('namesThing', () => {
	it('needs every significant word of the label as a whole word of the title', () => {
		expect(namesThing('Dental cleaning', 'Dentist checkup')).toBe(false);
		expect(namesThing('Delft board meeting', 'Delft project call')).toBe(false);
		expect(namesThing('anchovies', 'Olive oil')).toBe(false);
		expect(namesThing('Milk', 'Oat milk')).toBe(true);
		expect(namesThing('Oat milk', 'Oat milk')).toBe(true);
		// Not a part of a word.
		expect(namesThing('dent', 'Dentist checkup')).toBe(false);
	});

	it('also accepts a label that holds the whole title, like a leading article', () => {
		expect(namesThing('the bread', 'Bread')).toBe(true);
		expect(namesThing('milk', 'Oat milk')).toBe(true);
		expect(namesThing('Dentist checkup tomorrow', 'Dentist checkup')).toBe(true);
		expect(namesThing('the Delft board meeting', 'Delft project call')).toBe(false);
		expect(namesThing('4', '4')).toBe(true);
	});

	it('ignores case, spacing and brackets', () => {
		expect(namesThing('  DENTIST   checkup (14 Oct) ', 'Dentist checkup')).toBe(true);
	});

	it('has no plural rule of any language: another form is only a guess', () => {
		expect(namesThing('Dentist checkup', 'Dentist checkups')).toBe(false);
		expect(compareThing('Dentist checkup', 'Dentist checkups')).toEqual({
			band: 'weak',
			reason: 'forms',
		});
	});

	it('refuses a label without a significant word unless it is the title', () => {
		expect(namesThing('4', 'Oat milk')).toBe(false);
		expect(namesThing('4', '4')).toBe(true);
		expect(namesThing('  ', 'Oat milk')).toBe(false);
	});
});

describe('codes and numbers in namesThing', () => {
	it('tells classes and amounts apart', () => {
		expect(namesThing('8.B trip to bled on thu 29.10', 'Class 1B trip to Bled')).toBe(false);
		expect(namesThing('Class 3B trip to Bled', 'Class 1B trip to Bled')).toBe(false);
		expect(namesThing('Pay 18 EUR', 'Pay 10 EUR for the bus')).toBe(false);
	});

	it('still matches the same code, and a side without codes', () => {
		expect(namesThing('1B trip to Bled', 'Class 1B trip to Bled')).toBe(true);
		expect(namesThing('Class 8.B trip', 'Class 8b trip to Bled')).toBe(true);
		expect(namesThing('Class trip to Bled', 'Class 1B trip to Bled')).toBe(true);
		expect(namesThing('Pay 10 EUR', 'Pay 10 EUR for the bus')).toBe(true);
	});

	it('reads dotted and dashed codes, and ignores bracketed dates', () => {
		expect(namesThing('Match u-13 (Sat 24.10)', 'Match U13')).toBe(true);
		expect(namesThing('Match u-13', 'Match U15')).toBe(false);
		expect(namesThing('Yüzme 3.A sınıfı', 'Yüzme 3a sınıfı gezisi')).toBe(true);
	});
});

describe('searchFinds', () => {
	it('finds another form of a word when one starts the other and the shorter has four letters', () => {
		// "When is the swimming this week?" missed the "Swim training" events.
		expect(searchFinds('swimming', 'Swim training')).toBe(true);
		expect(searchFinds('swim', 'Swimming gala')).toBe(true);
		expect(searchFinds('swimming gala', 'Swim gala at the pool')).toBe(true);
		expect(searchFinds('Yüzme', 'yüzmeye gidiyoruz')).toBe(true);
	});

	it('keeps short words, other words and unrelated titles out', () => {
		expect(searchFinds('cars', 'Carpet cleaning')).toBe(false);
		expect(searchFinds('sw', 'Splash training')).toBe(false);
		expect(searchFinds('swimming pool', 'Swim training')).toBe(false);
		expect(searchFinds('dentist', 'Swim training')).toBe(false);
	});

	it('still finds a text contained as written', () => {
		expect(searchFinds('ing', 'Swimming gala')).toBe(true);
	});

	it('does not loosen the check of which item a change names', () => {
		expect(namesThing('swimming', 'Swim training')).toBe(false);
		expect(namesThing('Swim', 'Swimming gala')).toBe(false);
		expect(namedShares('swimming', ['Swim training'])).toEqual([0]);
	});
});
