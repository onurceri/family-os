import { describe, expect, it } from 'vitest';
import { listChanged } from '../src/web/shown-list.js';

describe('listChanged', () => {
	it('is true when another list is shown', () => {
		expect(listChanged('a', 'b')).toBe(true);
	});
	it('is true when the shown list goes away, or the first one appears', () => {
		expect(listChanged('a', undefined)).toBe(true);
		expect(listChanged(undefined, 'a')).toBe(true);
	});
	it('is false for the same list, so a re-read keeps its rows', () => {
		expect(listChanged('a', 'a')).toBe(false);
		expect(listChanged(undefined, undefined)).toBe(false);
	});
});
