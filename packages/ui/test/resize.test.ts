import { describe, expect, it } from 'vitest';
import { fitWithin } from '../src/famos/resize.ts';

describe('fitWithin', () => {
	it('shrinks the longest side to the limit and keeps the proportions', () => {
		expect(fitWithin(4000, 3000, 1400)).toEqual({ width: 1400, height: 1050 });
		expect(fitWithin(3000, 4000, 1920)).toEqual({ width: 1440, height: 1920 });
	});

	it('never enlarges and never reaches zero', () => {
		expect(fitWithin(800, 600, 1400)).toEqual({ width: 800, height: 600 });
		expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
	});
});
