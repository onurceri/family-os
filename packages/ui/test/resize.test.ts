import { describe, expect, it } from 'vitest';
import { fitWithin, squareCrop } from '../src/famos/resize.ts';

describe('squareCrop', () => {
	it('takes the middle of a wide or a tall picture', () => {
		expect(squareCrop(4000, 3000)).toEqual({ x: 500, y: 0, side: 3000 });
		expect(squareCrop(3000, 4000)).toEqual({ x: 0, y: 500, side: 3000 });
	});

	it('keeps a square whole and rounds an odd margin down', () => {
		expect(squareCrop(800, 800)).toEqual({ x: 0, y: 0, side: 800 });
		expect(squareCrop(101, 50)).toEqual({ x: 25, y: 0, side: 50 });
	});

	it('never reaches zero', () => {
		expect(squareCrop(1, 1000)).toEqual({ x: 0, y: 499, side: 1 });
	});
});

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
