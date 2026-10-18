import { describe, expect, it } from 'vitest';
import { canvasMeasure, titleFitter } from '../src/web/title-fit.ts';

describe('titleFitter', () => {
	it('says a title wraps when it is wider than the room', () => {
		const wraps = titleFitter((text) => text.length * 7);
		// "Parents' evening at school" is 26 characters: 182 px at 7 px each.
		expect(wraps("Parents' evening at school", 'bold 13px sans-serif', 120)).toBe(true);
		expect(wraps("Parents' evening at school", 'bold 13px sans-serif', 182)).toBe(false);
		expect(wraps('Dinner', 'bold 13px sans-serif', 120)).toBe(false);
	});

	it('measures a title once per font, whatever the column width', () => {
		let calls = 0;
		const wraps = titleFitter((text) => {
			calls++;
			return text.length * 7;
		});
		for (const room of [80, 100, 120, 140]) wraps('Swimming lesson', 'bold 13px a', room);
		expect(calls).toBe(1);
		wraps('Swimming lesson', 'bold 14px a', 100);
		wraps('Another', 'bold 13px a', 100);
		expect(calls).toBe(3);
	});

	it('has no canvas measure where there is no document', () => {
		expect(canvasMeasure()).toBeNull();
	});
});
