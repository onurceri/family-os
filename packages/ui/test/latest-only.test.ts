import { describe, expect, it } from 'vitest';
import { latestOnly } from '../src/latest-only.ts';

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

	it('drops an older answer that arrives last', async () => {
		const reads = latestOnly();
		let shown = '';
		const read = async (name: string, delay: number) => {
			const current = reads.begin();
			await new Promise((r) => setTimeout(r, delay));
			if (current()) shown = name;
		};
		await Promise.all([read('older', 20), read('newer', 1)]);
		expect(shown).toBe('newer');
	});
});
