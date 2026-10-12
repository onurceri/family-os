import { describe, expect, it } from 'vitest';
import { latestOnly } from '../src/web/latest-only.ts';

describe('latestOnly', () => {
	it('lets the newest read through and ignores older ones', () => {
		const reads = latestOnly();
		const first = reads.begin();
		const second = reads.begin();
		expect(first()).toBe(false);
		expect(second()).toBe(true);
	});

	it('keeps a read current until a newer one starts', () => {
		const reads = latestOnly();
		const only = reads.begin();
		expect(only()).toBe(true);
		reads.begin();
		expect(only()).toBe(false);
	});
});
