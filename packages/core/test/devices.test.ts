import { FamosError } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel();
});
afterEach(() => k.close());

describe('trusted devices', () => {
	it('trusts a device for parents only and stores just a hash of the token', async () => {
		const { actor: parent } = await k.member('admin');
		const { actor: child } = await k.member('member');
		await expect(k.devices.trust(child, { name: 'Phone' })).rejects.toBeInstanceOf(FamosError);

		const { device, token } = await k.devices.trust(parent, { name: '  Kitchen tablet  ' });
		expect(device.name).toBe('Kitchen tablet');
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const stored = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_devices')
			.selectAll()
			.execute();
		expect(stored).toHaveLength(1);
		expect(stored[0]?.token_hash).not.toContain(token);
		expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('verifies tokens, ignores garbage and stops working after revocation', async () => {
		const { actor: parent } = await k.member('admin');
		const { device, token } = await k.devices.trust(parent, { name: 'Tablet' });
		expect((await k.devices.verify(token))?.id).toBe(device.id);
		expect(await k.devices.verify('x'.repeat(43))).toBeNull();
		expect(await k.devices.verify(undefined)).toBeNull();

		await k.devices.revoke(parent, device.id);
		expect(await k.devices.verify(token)).toBeNull();
		expect(await k.devices.list()).toEqual([]);
		await expect(k.devices.revoke(parent, device.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('forgetting revokes the device from its own token, without an admin', async () => {
		const { actor: parent } = await k.member('admin');
		const { device, token } = await k.devices.trust(parent, { name: 'Tablet' });
		const other = await k.devices.trust(parent, { name: 'Other' });
		expect(await k.devices.forget('x'.repeat(43))).toBeNull();
		expect(await k.devices.forget(undefined)).toBeNull();

		expect(await k.devices.forget(token)).toBe(device.id);
		expect(await k.devices.verify(token)).toBeNull();
		expect(await k.devices.isActive(device.id)).toBe(false);
		expect((await k.devices.list()).map((d) => d.id)).toEqual([other.device.id]);
		// Already gone: nothing more to do.
		expect(await k.devices.forget(token)).toBeNull();
	});

	it('records last use at most hourly', async () => {
		const { actor: parent } = await k.member('admin');
		const { device, token } = await k.devices.trust(parent, { name: 'Tablet' });
		k.clock.advance(10 * 60 * 1000);
		expect((await k.devices.verify(token))?.last_seen_at).toBe(device.last_seen_at);
		k.clock.advance(60 * 60 * 1000);
		expect((await k.devices.verify(token))?.last_seen_at).toBe(k.clock.now());
	});
});
