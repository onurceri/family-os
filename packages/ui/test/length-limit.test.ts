import { describe, expect, it } from 'vitest';
import { counterText, lengthState } from '../src/famos/length-limit.js';

describe('lengthState', () => {
	it('counts only in the last 20 characters before the limit', () => {
		expect(lengthState('x'.repeat(139), 160).counting).toBe(false);
		expect(lengthState('x'.repeat(140), 160).counting).toBe(true);
	});

	it('is over only past the limit, by the trimmed length', () => {
		expect(lengthState('x'.repeat(160), 160).over).toBe(false);
		expect(lengthState(`  ${'x'.repeat(160)}  `, 160).over).toBe(false);
		expect(lengthState('x'.repeat(161), 160).over).toBe(true);
	});

	it('writes the counter as length over limit', () => {
		expect(counterText(lengthState('x'.repeat(212), 160))).toBe('212/160');
	});
});
