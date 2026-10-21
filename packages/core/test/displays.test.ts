import {
	type Actor,
	defineAction,
	defineCapability,
	defineRoute,
	FamosError,
	systemActor,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { displayActor, normalizeUserCode, PAIRING_TTL_MS } from '../src/devices.ts';
import type { CoreTables, DeviceRow } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const peekView = defineCapability({ id: 'peek.view', label: 'peek:cap_view', level: 'view' });
const peekOther = defineCapability({ id: 'peek.other', label: 'peek:cap_other', level: 'view' });
const peekEdit = defineCapability({ id: 'peek.edit', label: 'peek:cap_edit', level: 'edit' });
const peek = defineTestExtension({
	id: 'peek',
	capabilities: [peekView, peekOther, peekEdit],
	actions: [
		defineAction({
			id: 'peek.look',
			title: 'Look',
			input: z.object({}),
			output: z.object({}),
			readOnly: true,
			requires: peekView.id,
			approval: 'never',
			async run() {
				return {};
			},
		}),
		defineAction({
			id: 'peek.free',
			title: 'Read without a capability',
			input: z.object({}),
			output: z.object({}),
			readOnly: true,
			approval: 'never',
			async run() {
				return {};
			},
		}),
	],
	routes: [
		defineRoute({
			method: 'get',
			path: '/things',
			operationId: 'peek.listThings',
			summary: 'Things',
			requires: peekView.id,
			response: z.object({ ok: z.literal(true) }),
			async handle() {
				return { ok: true as const };
			},
		}),
	],
});

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [peek] });
});
afterEach(() => k.close());

async function pair(grant: { capabilities?: string[]; showNames?: boolean; name?: string } = {}) {
	const { actor: admin } = await k.member('admin');
	const start = await k.devices.startPairing();
	await k.devices.confirmPairing(admin, start.userCode, {
		name: grant.name ?? 'Hallway',
		capabilities: grant.capabilities ?? ['peek.view'],
		showNames: grant.showNames ?? false,
	});
	const polled = await k.devices.pollPairing(start.deviceCode);
	if (polled.status !== 'paired') throw new Error(`expected paired, got ${polled.status}`);
	return {
		admin,
		token: polled.token,
		device: polled.device,
		actor: displayActor(polled.device) as Actor,
	};
}

describe('pairing a display', () => {
	it('runs the whole flow: start, pending, confirm, paired once, then gone', async () => {
		const { actor: admin } = await k.member('admin');
		const start = await k.devices.startPairing({ ip: '10.0.0.1' });
		expect(start.userCode).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
		expect(start.deviceCode.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
		expect(start.expiresAt).toBe(k.clock.now() + PAIRING_TTL_MS);

		expect(await k.devices.pollPairing(start.deviceCode)).toEqual({ status: 'pending' });
		const confirmed = await k.devices.confirmPairing(admin, start.userCode.toLowerCase(), {
			name: '  Hallway  ',
			capabilities: ['peek.view', 'peek.view'],
			showNames: true,
		});
		expect(confirmed.name).toBe('Hallway');

		k.clock.advance(5000);
		const paired = await k.devices.pollPairing(start.deviceCode);
		if (paired.status !== 'paired') throw new Error('expected paired');
		expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(paired.device).toMatchObject({ name: 'Hallway', kind: 'kiosk' });

		// The token works, only its hash is stored, and the device code cannot be used again.
		expect((await k.devices.verify(paired.token))?.id).toBe(paired.device.id);
		const rows = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_devices')
			.selectAll()
			.execute();
		expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
		const pairing = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_display_pairings')
			.selectAll()
			.execute();
		expect(JSON.stringify(pairing)).not.toContain(start.deviceCode);
		expect(JSON.stringify(pairing)).not.toContain(paired.token);
		k.clock.advance(5000);
		expect(await k.devices.pollPairing(start.deviceCode)).toEqual({ status: 'expired' });
		// The user code is single-use too.
		await expect(
			k.devices.confirmPairing(admin, start.userCode, {
				name: 'Again',
				capabilities: [],
				showNames: false,
			}),
		).rejects.toMatchObject({ code: 'not_found' });
		expect(await k.devices.list()).toHaveLength(1);
	});

	it('says connected only once the display has claimed the confirmed code', async () => {
		const { actor: admin } = await k.member('admin');
		const grant = { name: 'Kitchen wall', capabilities: ['peek.view'], showNames: false };

		// Nobody polls this code (the screen was closed, or it was asked for by hand): it waits,
		// says no screen is asking, and runs out without a device.
		const unclaimed = await k.devices.startPairing();
		const lonely = await k.devices.confirmPairing(admin, unclaimed.userCode, grant);
		expect(await k.devices.pairingStatus(admin, lonely.pairingId)).toEqual({
			status: 'waiting',
			answering: false,
		});
		k.clock.advance(PAIRING_TTL_MS + 1);
		expect(await k.devices.pairingStatus(admin, lonely.pairingId)).toEqual({ status: 'expired' });
		expect(await k.devices.list()).toHaveLength(0);

		// A screen that keeps asking: waiting while it asks, connected once its next poll claims it.
		const start = await k.devices.startPairing();
		expect((await k.devices.pollPairing(start.deviceCode)).status).toBe('pending');
		const { pairingId } = await k.devices.confirmPairing(admin, start.userCode, grant);
		expect(await k.devices.pairingStatus(admin, pairingId)).toEqual({
			status: 'waiting',
			answering: true,
		});
		k.clock.advance(5000);
		const paired = await k.devices.pollPairing(start.deviceCode);
		if (paired.status !== 'paired') throw new Error('expected paired');
		expect(await k.devices.pairingStatus(admin, pairingId)).toEqual({
			status: 'connected',
			deviceId: paired.device.id,
		});

		expect(await k.devices.pairingStatus(admin, 'pairing_unknown')).toEqual({ status: 'expired' });
		const { actor: member } = await k.member('member');
		await expect(k.devices.pairingStatus(member, pairingId)).rejects.toMatchObject({
			code: 'forbidden',
		});
	});

	it('tells a display that polls too fast to slow down', async () => {
		const start = await k.devices.startPairing();
		expect((await k.devices.pollPairing(start.deviceCode)).status).toBe('pending');
		k.clock.advance(1000);
		expect((await k.devices.pollPairing(start.deviceCode)).status).toBe('slow_down');
		k.clock.advance(5000);
		expect((await k.devices.pollPairing(start.deviceCode)).status).toBe('pending');
	});

	it('expires after ten minutes, for polling and confirming', async () => {
		const { actor: admin } = await k.member('admin');
		const start = await k.devices.startPairing();
		k.clock.advance(PAIRING_TTL_MS + 1);
		expect(await k.devices.pollPairing(start.deviceCode)).toEqual({ status: 'expired' });
		await expect(
			k.devices.confirmPairing(admin, start.userCode, {
				name: 'X',
				capabilities: [],
				showNames: false,
			}),
		).rejects.toMatchObject({ code: 'not_found' });
		expect(await k.devices.pollPairing('nonsense')).toEqual({ status: 'expired' });
		expect(await k.devices.pollPairing('x'.repeat(43))).toEqual({ status: 'expired' });
	});

	it('ends a pairing after five wrong codes', async () => {
		const { actor: admin } = await k.member('admin');
		const start = await k.devices.startPairing();
		const grant = { name: 'X', capabilities: [], showNames: false };
		for (let i = 0; i < 5; i++) {
			await expect(k.devices.confirmPairing(admin, 'AAAA-AAAA', grant)).rejects.toMatchObject({
				code: 'not_found',
			});
		}
		await expect(k.devices.confirmPairing(admin, start.userCode, grant)).rejects.toMatchObject({
			code: 'not_found',
		});
		// A fresh code works again.
		const next = await k.devices.startPairing();
		await k.devices.confirmPairing(admin, next.userCode, grant);
	});

	it('limits how many pairings can wait at once', async () => {
		for (let i = 0; i < 100; i++) await k.devices.startPairing();
		await expect(k.devices.startPairing()).rejects.toMatchObject({ code: 'limit_reached' });
	});

	it('keeps slots for the home network that pairings from outside cannot take', async () => {
		for (let i = 0; i < 100; i++) await k.devices.startPairing({ ip: `198.51.100.${i}` });
		await expect(k.devices.startPairing({ ip: '203.0.113.1' })).rejects.toMatchObject({
			code: 'limit_reached',
		});
		for (let i = 0; i < 100; i++)
			await k.devices.startPairing({ ip: `10.0.${Math.floor(i / 3)}.${i % 3}`, local: true });
		// The home network is bounded too, and its own pairings never open the cap to outside.
		await expect(k.devices.startPairing({ ip: '10.9.9.9', local: true })).rejects.toMatchObject({
			code: 'limit_reached',
		});
		await expect(k.devices.startPairing({ ip: '203.0.113.1' })).rejects.toMatchObject({
			code: 'limit_reached',
		});
	});

	it('keeps one address from taking every open slot', async () => {
		for (let i = 0; i < 3; i++) await k.devices.startPairing({ ip: '10.0.0.7' });
		await expect(k.devices.startPairing({ ip: '10.0.0.7' })).rejects.toMatchObject({
			code: 'limit_reached',
		});
		// Other addresses still get through.
		await k.devices.startPairing({ ip: '10.0.0.8' });
		await k.devices.startPairing();
	});

	it('lets only admins confirm, and only view capabilities of extensions that are on', async () => {
		const { actor: child } = await k.member('member');
		const { actor: admin } = await k.member('admin');
		const start = await k.devices.startPairing();
		const grant = { name: 'X', capabilities: ['peek.view'], showNames: false };
		await expect(k.devices.confirmPairing(child, start.userCode, grant)).rejects.toBeInstanceOf(
			FamosError,
		);
		await expect(
			k.devices.confirmPairing(systemActor('x'), start.userCode, grant),
		).rejects.toMatchObject({ code: 'forbidden' });
		for (const bad of [
			'peek.edit',
			'core.members.manage',
			'core.members.view',
			'nope.view',
			'core.notifications.receive',
		]) {
			await expect(
				k.devices.confirmPairing(admin, start.userCode, { ...grant, capabilities: [bad] }),
			).rejects.toMatchObject({ code: 'bad_request' });
		}
		await expect(
			k.devices.confirmPairing(admin, start.userCode, { ...grant, name: '  ' }),
		).rejects.toMatchObject({ code: 'bad_request' });
		await k.runner.invoke('core.setFeatureEnabled', { extensionId: 'peek', enabled: false }, admin);
		expect(k.devices.grantableCapabilities().map((c) => c.id)).toEqual(['core.drafts.waiting']);
		await expect(k.devices.confirmPairing(admin, start.userCode, grant)).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	it('normalizes typed codes', () => {
		expect(normalizeUserCode('abcd efgh')).toBe('ABCD-EFGH');
		expect(normalizeUserCode('ABCD-EFG0')).toBeNull();
		expect(normalizeUserCode('short')).toBeNull();
	});
});

describe('what a display can do', () => {
	it('uses only the granted view capabilities of extensions that are on', async () => {
		const { actor } = await pair({ capabilities: ['peek.view'] });
		expect(k.access.can(actor, 'peek.view')).toBe(true);
		expect(k.access.can(actor, 'peek.other')).toBe(false); // view level, but not granted
		expect(k.access.can(actor, 'peek.edit')).toBe(false);
		expect(k.access.can(actor, 'core.devices.manage')).toBe(false);
		expect(k.access.can(actor, 'core.members.manage')).toBe(false);
		expect(k.access.can(actor, 'core.drafts.approve')).toBe(false);

		const { actor: admin } = await k.member('admin');
		await k.runner.invoke('core.setFeatureEnabled', { extensionId: 'peek', enabled: false }, admin);
		expect(k.access.can(actor, 'peek.view')).toBe(false);
	});

	it('sees members only when names are allowed, and never their roles or notes', async () => {
		const quiet = await pair({ name: 'Quiet' });
		const loud = await pair({ name: 'Loud', showNames: true });
		expect(k.access.can(quiet.actor, 'core.members.view')).toBe(false);
		expect(k.access.can(loud.actor, 'core.members.view')).toBe(true);

		await k.runner.invoke(
			'core.updateMember',
			{ memberId: (await k.member('member')).member.id, about: 'private note' },
			loud.admin,
		);
		const members = await k.route('core.listMembers').call({ actor: loud.actor });
		expect(members.length).toBeGreaterThan(0);
		for (const m of members) expect(m).toMatchObject({ roleId: '', about: null });
		await expect(k.route('core.listRoles').call({ actor: loud.actor })).rejects.toMatchObject({
			code: 'forbidden',
		});
	});

	it('cannot run any action, not even a read-only one', async () => {
		const { actor } = await pair({ capabilities: ['peek.view'] });
		for (const id of [
			'peek.look',
			'peek.free',
			'core.createMember',
			'core.markNotificationsRead',
		]) {
			await expect(k.runner.invoke(id, {}, actor)).rejects.toMatchObject({ code: 'forbidden' });
		}
	});

	it('is no display when the device is a family device, revoked or not a display', async () => {
		const { admin, device } = await pair();
		const family = await k.devices.trust(admin, { name: 'Tablet' });
		expect(displayActor(family.device)).toBeNull();
		expect(displayActor(null)).toBeNull();
		expect(displayActor({ ...device, display_capabilities: null })).toBeNull();
		await k.devices.revoke(admin, device.id);
		expect(displayActor({ ...device, revoked_at: 1 } as DeviceRow)).toBeNull();
		expect(await k.devices.isActive(family.device.id)).toBe(true);
		expect(await k.devices.isActive(device.id)).toBe(false);
	});

	it('can be renamed and have its permissions changed by an admin', async () => {
		const { admin, device, token } = await pair();
		const { actor: child } = await k.member('member');
		await expect(
			k.devices.updateDisplay(child, device.id, { name: 'Mine' }),
		).rejects.toBeInstanceOf(FamosError);
		const updated = await k.devices.updateDisplay(admin, device.id, {
			name: 'Kitchen',
			capabilities: ['peek.other'],
			showNames: true,
		});
		expect(updated).toMatchObject({ name: 'Kitchen', display_show_names: 1 });
		const actor = displayActor(await k.devices.verify(token));
		expect(actor).toMatchObject({ kind: 'display', capabilities: ['peek.other'], showNames: true });
		await expect(
			k.devices.updateDisplay(admin, device.id, { capabilities: ['peek.edit'] }),
		).rejects.toMatchObject({ code: 'bad_request' });
		const family = await k.devices.trust(admin, { name: 'Phone' });
		await expect(
			k.devices.updateDisplay(admin, family.device.id, { name: 'X' }),
		).rejects.toMatchObject({ code: 'not_found' });
		const listed = (await k.devices.list()).find((d) => d.id === device.id);
		expect(listed?.name).toBe('Kitchen');
	});

	it('keeps what its screen had no room for, says so only when it changes, forgets it when revoked', async () => {
		const { admin, device } = await pair();
		const heard: string[] = [];
		k.bus.onAny((name) => void heard.push(name));
		expect(k.devices.leftOut(device.id)).toEqual([]);

		await k.devices.reportFit(device.id, ['peek.widget', 'family', 'family']);
		expect(k.devices.leftOut(device.id)).toEqual(['family', 'peek.widget']);
		// The same again (in another order) is no news.
		await k.devices.reportFit(device.id, ['family', 'peek.widget']);
		expect(heard.filter((n) => n === 'core.displayFit.changed')).toHaveLength(1);

		await k.devices.reportFit(device.id, []);
		expect(k.devices.leftOut(device.id)).toEqual([]);
		expect(heard.filter((n) => n === 'core.displayFit.changed')).toHaveLength(2);

		await k.devices.reportFit(device.id, ['chores']);
		await k.devices.revoke(admin, device.id);
		expect(k.devices.leftOut(device.id)).toEqual([]);
	});

	it('stops at once when revoked', async () => {
		const { admin, device, token } = await pair();
		expect(displayActor(await k.devices.verify(token))).not.toBeNull();
		await k.devices.revoke(admin, device.id);
		expect(displayActor(await k.devices.verify(token))).toBeNull();
	});
});
