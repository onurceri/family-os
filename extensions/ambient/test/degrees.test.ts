import { describe, expect, it } from 'vitest';
import { formatDegrees, formatWhole } from '../src/web/degrees.js';

describe('temperatures in the family region format', () => {
	it('rounds and adds the unit letter', () => {
		expect(formatDegrees(21.6, 'en-GB', 'celsius')).toBe('22°C');
		expect(formatDegrees(70.2, 'en-US', 'fahrenheit')).toBe('70°F');
		expect(formatDegrees(21.6, 'en-GB')).toBe('22°');
	});

	it('uses the region format of the family for the minus sign and the digits', () => {
		expect(formatDegrees(-3.2, 'sv-SE', 'celsius')).toBe('−3°C');
		expect(formatWhole(12, 'ar-EG')).toBe('١٢');
	});

	it('never shows minus zero', () => {
		expect(formatDegrees(-0.4, 'en-GB', 'celsius')).toBe('0°C');
		expect(formatWhole(-0.2, 'en-GB')).toBe('0');
	});
});
