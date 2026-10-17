import { describe, expect, it } from 'vitest';
import { needsAnyProvider } from './zero-retention.js';

describe('needsAnyProvider', () => {
	const kept = new Set(['vendor/private-model']);

	it('marks a model without a provider that keeps no data while the option is on', () => {
		expect(needsAnyProvider('vendor/free-model:free', kept, true)).toBe(true);
		expect(needsAnyProvider(' vendor/private-model ', kept, true)).toBe(false);
	});

	it('marks nothing while the option is off or nothing is known', () => {
		expect(needsAnyProvider('vendor/free-model:free', kept, false)).toBe(false);
		expect(needsAnyProvider('vendor/free-model:free', undefined, true)).toBe(false);
		expect(needsAnyProvider('', kept, true)).toBe(false);
	});
});
