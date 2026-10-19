import { describe, expect, it } from 'vitest';
import { mergeQuantity, quantityUnit } from '../src/contract/amount.ts';

describe('quantityUnit', () => {
	it('is what the amount counts in', () => {
		expect(quantityUnit('2 L')).toBe('l');
		expect(quantityUnit('1,5 kg')).toBe('kg');
		expect(quantityUnit('½ cup')).toBe('cup');
		expect(quantityUnit('3')).toBe('');
		expect(quantityUnit('2 pcs.')).toBe('pcs');
		expect(quantityUnit('a dozen')).toBe('a dozen');
	});
});

describe('mergeQuantity', () => {
	it('keeps both when the units differ', () => {
		expect(mergeQuantity('2 L', '2')).toBe('2 L + 2');
		expect(mergeQuantity('1 kg', 'a bag')).toBe('1 kg + a bag');
	});

	it('replaces the amount in the same unit, whatever its case', () => {
		expect(mergeQuantity('2 L', '3 l')).toBe('3 l');
		expect(mergeQuantity('12', '4')).toBe('4');
		expect(mergeQuantity('2 L + 2', '5 L')).toBe('5 L + 2');
		expect(mergeQuantity('2 L + 2', '5')).toBe('2 L + 5');
	});

	it('is safe to repeat', () => {
		const once = mergeQuantity('2 L', '2');
		expect(mergeQuantity(once, '2')).toBe(once);
	});

	it('keeps what the list has when the add has no amount, and takes the add when the list has none', () => {
		expect(mergeQuantity('2 L', null)).toBe('2 L');
		expect(mergeQuantity('2 L', '  ')).toBe('2 L');
		expect(mergeQuantity('2 L', undefined)).toBe('2 L');
		expect(mergeQuantity(null, '2')).toBe('2');
	});
});
