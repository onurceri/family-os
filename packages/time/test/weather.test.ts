import { describe, expect, it } from 'vitest';
import { isWetCode, weatherKind } from '../src/index.ts';

describe('weatherKind', () => {
	const table: [number[], string][] = [
		[[0, 1], 'clear'],
		[[2], 'partly'],
		[[3], 'cloud'],
		[[45, 48], 'fog'],
		[[51, 53, 55, 56, 57], 'drizzle'],
		[[61, 63, 65, 66, 67, 80, 81, 82], 'rain'],
		[[71, 73, 75, 77, 85, 86], 'snow'],
		[[95, 96, 99], 'storm'],
		[[4, 58, 83, 100, -1], 'cloud'],
	];
	for (const [codes, kind] of table)
		it(`${codes.join(', ')} is ${kind}`, () => {
			for (const code of codes) expect(weatherKind(code)).toBe(kind);
		});

	it('knows which codes fall', () => {
		expect([0, 3, 45].some(isWetCode)).toBe(false);
		expect([51, 61, 71, 85, 95].every(isWetCode)).toBe(true);
	});
});
