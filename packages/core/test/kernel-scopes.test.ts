import { describe, expect, it } from 'vitest';
import { createKernel, type KernelOptions } from '../src/kernel.ts';
import { createTestKernel } from './harness.ts';

describe('who is the host', () => {
	it('gives the host context to core and infrastructure scopes only', async () => {
		const k = await createTestKernel();
		try {
			expect(k.contextFor('core')).toBe(k.ctx);
			// The mailbox check is an infrastructure job and runs with the host context.
			expect(() => k.contextFor('email')).not.toThrow();
			expect(() => k.contextFor('no_such_extension')).toThrow(/neither a loaded extension/);
		} finally {
			await k.close();
		}
	});

	it('refuses to start without a setup code', () => {
		expect(() => createKernel({ setupCode: '' } as KernelOptions)).toThrow(/setup code/);
	});
});
