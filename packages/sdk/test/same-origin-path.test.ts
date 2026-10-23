import { describe, expect, it } from 'vitest';
import { isSameOriginPath } from '../src/same-origin-path.ts';

const base = 'https://home.example';

describe('isSameOriginPath', () => {
	it('accepts paths on the same origin', () => {
		expect(isSameOriginPath('/a', base)).toBe(true);
		expect(isSameOriginPath('/a/b?x=1#y', base)).toBe(true);
	});

	it('refuses other origins however they are written', () => {
		for (const path of [
			'/\\evil.example',
			'//evil.example',
			'/%5Cevil.example',
			'/%5cevil.example',
			'javascript:alert(1)',
			'\t/x',
			'/\t/evil.example',
			'/\n/evil.example',
			'evil.example',
			'',
			'https://home.example/a',
			'https://evil.example/a',
		]) {
			expect(isSameOriginPath(path, base), path).toBe(false);
		}
		expect(isSameOriginPath(null, base)).toBe(false);
		expect(isSameOriginPath(undefined, base)).toBe(false);
	});

	it('refuses everything when the base is not a URL', () => {
		expect(isSameOriginPath('/a', 'nope')).toBe(false);
	});
});
