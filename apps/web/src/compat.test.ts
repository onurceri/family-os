import { afterEach, describe, expect, it, vi } from 'vitest';

const METHODS = ['toSorted', 'toReversed', 'toSpliced', 'with'] as const;
const proto = Array.prototype as unknown as Record<string, unknown>;

describe('compat', () => {
	const saved = METHODS.map(
		(name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
	);
	afterEach(() => {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(proto, name, descriptor);
		}
	});

	it('installs the array copy methods an older browser lacks', async () => {
		for (const name of METHODS) delete proto[name];
		expect(proto.toSorted).toBeUndefined();
		vi.resetModules();
		await import('./compat');
		const list = [3, 1, 2];
		expect(list.toSorted()).toEqual([1, 2, 3]);
		expect(list.toReversed()).toEqual([2, 1, 3]);
		expect(list.toSpliced(0, 1)).toEqual([1, 2]);
		expect(list.with(0, 9)).toEqual([9, 1, 2]);
		expect(list).toEqual([3, 1, 2]);
	});
});
