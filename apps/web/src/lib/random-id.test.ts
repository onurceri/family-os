import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './random-id.js';

afterEach(() => vi.unstubAllGlobals());

describe('randomId', () => {
	it('makes a v4 UUID without crypto.randomUUID', () => {
		vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(crypto) });
		expect((crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
		const id = randomId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(randomId()).not.toBe(id);
	});
});
