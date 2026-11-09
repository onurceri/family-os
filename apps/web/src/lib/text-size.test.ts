import { describe, expect, it } from 'vitest';
import { parseTextSize } from './text-size.js';

describe('parseTextSize', () => {
	it('keeps the stored sizes', () => {
		expect(parseTextSize('small')).toBe('small');
		expect(parseTextSize('large')).toBe('large');
		expect(parseTextSize('larger')).toBe('larger');
	});

	it('reads anything else as no choice, normal included (it is never stored)', () => {
		expect(parseTextSize(null)).toBeNull();
		expect(parseTextSize('normal')).toBeNull();
		expect(parseTextSize('huge')).toBeNull();
		expect(parseTextSize('')).toBeNull();
	});
});
