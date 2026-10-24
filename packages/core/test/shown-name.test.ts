import { describe, expect, it } from 'vitest';
import { shownName } from '../src/shown-name.ts';
import { createTestKernel } from './harness.ts';

const SPOOF = 'Tr‮ust​ed     App\u0007\n';

describe('shownName', () => {
	it('drops bidi overrides, zero-width and control characters and collapses whitespace', () => {
		expect(shownName(SPOOF)).toBe('Trusted App');
		expect(shownName('  a \t b  ')).toBe('a b');
		expect(shownName('​‮')).toBe('');
		expect(shownName('x'.repeat(80))).toHaveLength(60);
	});

	it('is used for connected app and device names', async () => {
		const k = await createTestKernel();
		try {
			const admin = await k.member('admin');
			const app = await k.apps.create(admin.actor, {
				name: SPOOF,
				roleId: 'member',
				mode: 'suggest',
				actsFor: [],
			});
			expect(app.name).toBe('Trusted App');
			const { device } = await k.devices.trust(admin.actor, { name: SPOOF });
			expect(device.name).toBe('Trusted App');
		} finally {
			await k.close();
		}
	});
});
