import { type Actor, isFamosError, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

/** An extension that tries to run admin actions as the AI it works for. */
const sneaky = defineTestExtension({ id: 'sneaky' });

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let member: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [sneaky] });
	admin = await k.member('admin');
	member = await k.member('member');
});
afterEach(() => k.close());

const auditOf = (actionId: string) =>
	k.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_audit_log')
		.select(['action_id', 'outcome', 'target', 'actor'])
		.where('action_id', '=', actionId)
		.execute();

const invoke = (id: string, input: unknown, actor: Actor) => k.runner.invoke(id, input, actor);

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		const result = (await promise) as { status?: string };
		return result.status ?? 'ok';
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
}

const appActor = (roleId = 'admin'): Actor => ({
	kind: 'app',
	appId: 'app_0198c2a0-0000-7000-8000-000000000001',
	roleId,
	mode: 'apply',
});
const aiFor = (memberId: MemberId): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: memberId,
	roleId: 'admin',
});

async function newApp() {
	const made = await invoke(
		'core.createApp',
		{ name: 'Home Assistant', roleId: 'member', mode: 'apply' },
		admin.actor,
	);
	if (made.status !== 'applied') throw new Error('expected an app');
	const app = made.output as { id: string };
	const key = await k.apps.createToken(admin.actor, app.id, { name: 'first' });
	return { appId: app.id, tokenId: key.token.id, secret: key.secret };
}

/** Pairs a display: the code is confirmed by the action, then claimed by the display. */
async function newDisplay() {
	const start = await k.devices.startPairing();
	const confirmed = await invoke(
		'core.confirmDisplayPairing',
		{ userCode: start.userCode, name: 'Hallway', capabilities: [], showNames: false },
		admin.actor,
	);
	expect(confirmed.status).toBe('applied');
	const poll = await k.devices.pollPairing(start.deviceCode);
	if (poll.status !== 'paired') throw new Error('expected a display');
	return poll.device;
}

describe('admin changes to connected apps are actions', () => {
	it('applies them for an admin and names the app or key in the audit log', async () => {
		const { appId, tokenId, secret } = await newApp();
		expect(await auditOf('core.createApp')).toMatchObject([{ outcome: 'applied', target: null }]);

		const updated = await invoke('core.updateApp', { appId, mode: 'suggest' }, admin.actor);
		expect(updated).toMatchObject({ status: 'applied', output: { id: appId, mode: 'suggest' } });
		await invoke('core.pauseApp', { appId }, admin.actor);
		expect(await k.apps.isPaused(secret)).toBe(true);
		await invoke('core.resumeApp', { appId }, admin.actor);
		expect(await k.apps.authenticate(secret)).not.toBeNull();
		const revoked = await invoke('core.revokeAppToken', { appId, tokenId }, admin.actor);
		expect(revoked).toMatchObject({ status: 'applied', output: { id: tokenId } });
		expect(await k.apps.authenticate(secret)).toBeNull();
		await invoke('core.revokeApp', { appId }, admin.actor);

		for (const id of ['core.updateApp', 'core.pauseApp', 'core.resumeApp', 'core.revokeApp'])
			expect(await auditOf(id)).toMatchObject([{ outcome: 'applied', target: appId }]);
		const [row] = await auditOf('core.revokeAppToken');
		expect(row).toMatchObject({ target: tokenId });
		// Who did it, never what was sent or a secret.
		expect(JSON.parse(row?.actor ?? '{}')).toEqual(admin.actor);
		const everything = JSON.stringify(
			await k.ctx.db.withTables<CoreTables>().selectFrom('core_audit_log').selectAll().execute(),
		);
		expect(everything).not.toContain(secret);
		expect(everything).not.toContain('Home Assistant');
	});

	it('never answers with a secret, so a replayed answer holds none', async () => {
		const made = await k.runner.invoke(
			'core.createApp',
			{ name: 'Script', roleId: 'member', mode: 'apply' },
			admin.actor,
			{ idempotencyKey: 'create-script' },
		);
		expect(made.status).toBe('applied');
		const appId = (made as { output: { id: string } }).output.id;
		const key = await k.apps.createToken(admin.actor, appId, { name: 'first' });
		const stored = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_idempotency')
			.select('response')
			.execute();
		expect(stored).toHaveLength(1);
		expect(JSON.stringify(stored)).not.toContain(key.secret);
		expect(JSON.stringify(stored)).not.toContain('famos_');
	});

	it('refuses a member, a supervised child, an app, the AI and a PIN sign-in', async () => {
		const { appId } = await newApp();
		const child = await k.member('supervised');
		const pin: Actor = { ...admin.actor, pin: true };
		const refused = [
			member.actor,
			child.actor,
			appActor(),
			aiFor(admin.member.id as MemberId),
			pin,
		];
		for (const actor of refused) {
			expect(await codeOf(invoke('core.pauseApp', { appId }, actor))).toBe('forbidden');
			expect(
				await codeOf(
					invoke('core.createApp', { name: 'X', roleId: 'member', mode: 'apply' }, actor),
				),
			).toBe('forbidden');
		}
		// Nothing was drafted and nothing changed.
		expect(await k.apps.list(admin.actor)).toMatchObject([{ id: appId, pausedAt: null }]);
		expect(await auditOf('core.pauseApp')).toEqual([]);
		expect(
			await k.ctx.db.withTables<CoreTables>().selectFrom('core_drafts').select('id').execute(),
		).toEqual([]);
	});
});

describe('keys of AI apps and the MCP switch are actions', () => {
	it('lets the owner revoke their own key and an AI manager anyone’s, naming the key', async () => {
		const own = await k.apiTokens.create(member.actor, { name: 'Laptop', scope: 'read' });
		const other = await k.apiTokens.create(admin.actor, { name: 'Desk', scope: 'read' });
		expect(
			await codeOf(invoke('core.revokeApiToken', { tokenId: other.token.id }, member.actor)),
		).toBe('not_found');
		expect(
			await invoke('core.revokeApiToken', { tokenId: own.token.id }, member.actor),
		).toMatchObject({ status: 'applied', output: { id: own.token.id } });
		expect(await k.apiTokens.authenticate(own.secret)).toBeNull();
		await invoke('core.revokeApiToken', { tokenId: other.token.id }, admin.actor);
		expect(await auditOf('core.revokeApiToken')).toMatchObject([
			{ target: own.token.id },
			{ target: other.token.id },
		]);
	});

	it('keeps an app and the AI away from keys: not run, not suggested', async () => {
		const own = await k.apiTokens.create(member.actor, { name: 'Laptop', scope: 'read' });
		expect(
			await codeOf(invoke('core.revokeApiToken', { tokenId: own.token.id }, appActor('member'))),
		).toBe('forbidden');
		const assistant: Actor = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: member.member.id as MemberId,
			roleId: 'member',
		};
		await expect(
			invoke('core.revokeApiToken', { tokenId: own.token.id }, assistant),
		).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'critical' } });
		expect(
			await codeOf(
				k
					.contextFor('sneaky')
					.actions.invoke(
						'core.revokeApiToken',
						{ tokenId: own.token.id },
						{ kind: 'ai', mode: 'agent', source: 'sneaky' },
					),
			),
		).toBe('forbidden');
		expect(await k.apiTokens.authenticate(own.secret)).not.toBeNull();
		expect(
			await k.ctx.db.withTables<CoreTables>().selectFrom('core_drafts').select('id').execute(),
		).toEqual([]);
	});

	it('turns the MCP door on and off for an admin only', async () => {
		expect(await codeOf(invoke('core.setMcpEnabled', { enabled: true }, member.actor))).toBe(
			'forbidden',
		);
		expect(
			await codeOf(
				invoke('core.setMcpEnabled', { enabled: true }, aiFor(admin.member.id as MemberId)),
			),
		).toBe('forbidden');
		expect(await k.apiTokens.isEnabled()).toBe(false);
		await invoke('core.setMcpEnabled', { enabled: true }, admin.actor);
		expect(await k.apiTokens.isEnabled()).toBe(true);
		expect(await auditOf('core.setMcpEnabled')).toMatchObject([{ outcome: 'applied' }]);
	});
});

describe('displays and devices are changed by actions', () => {
	it('confirms, renames and revokes a display, telling its screens each time', async () => {
		const changed: string[] = [];
		k.bus.on({ name: 'core.device.changed' } as never, (payload: unknown) => {
			changed.push((payload as { deviceId: string }).deviceId);
		});
		const display = await newDisplay();
		expect(await auditOf('core.confirmDisplayPairing')).toMatchObject([{ outcome: 'applied' }]);

		const renamed = await invoke(
			'core.updateDisplay',
			{ deviceId: display.id, name: 'Kitchen' },
			admin.actor,
		);
		expect(renamed).toMatchObject({
			status: 'applied',
			output: { id: display.id, name: 'Kitchen' },
		});
		const gone = await invoke('core.revokeDevice', { deviceId: display.id }, admin.actor);
		expect(gone.status).toBe('applied');
		expect(await k.devices.verify('x'.repeat(43))).toBeNull();
		expect((await k.devices.list()).map((d) => d.id)).not.toContain(display.id);
		expect(changed.filter((id) => id === display.id).length).toBeGreaterThanOrEqual(3);
		expect(await auditOf('core.updateDisplay')).toMatchObject([{ target: display.id }]);
		expect(await auditOf('core.revokeDevice')).toMatchObject([{ target: display.id }]);
	});

	it('stops a revoked family device at once and ends its sessions from the queue', async () => {
		const { device, token } = await k.devices.trust(admin.actor, { name: 'Tablet' });
		await invoke('core.revokeDevice', { deviceId: device.id }, admin.actor);
		// The device stops counting in the same transaction; its sessions end in the job.
		expect(await k.devices.verify(token)).toBeNull();
		expect(await k.devices.isActive(device.id)).toBe(false);
		const jobs = await k.ctx.db
			.withTables<{ queue_jobs: { name: string; payload: string; status: string } }>()
			.selectFrom('queue_jobs')
			.select(['name', 'payload', 'status'])
			.where('name', '=', 'core.endDeviceSessions')
			.execute();
		expect(jobs).toEqual([
			{
				name: 'core.endDeviceSessions',
				payload: JSON.stringify({ deviceId: device.id }),
				status: 'pending',
			},
		]);
		await k.worker.drain();
		const done = await k.ctx.db
			.withTables<{ queue_jobs: { name: string; status: string } }>()
			.selectFrom('queue_jobs')
			.select('status')
			.where('name', '=', 'core.endDeviceSessions')
			.executeTakeFirst();
		expect(done?.status).toBe('succeeded');
	});

	it('counts a wrong code even though the confirmation is refused', async () => {
		const start = await k.devices.startPairing();
		for (let i = 0; i < 5; i++)
			expect(
				await codeOf(
					invoke(
						'core.confirmDisplayPairing',
						{ userCode: 'AAAA-AAAA', name: 'X', capabilities: [], showNames: false },
						admin.actor,
					),
				),
			).toBe('not_found');
		// Five misses end every open pairing, the right code too.
		expect(
			await codeOf(
				invoke(
					'core.confirmDisplayPairing',
					{ userCode: start.userCode, name: 'X', capabilities: [], showNames: false },
					admin.actor,
				),
			),
		).toBe('not_found');
	});

	it('refuses a member, an app, the AI and a display', async () => {
		const display = await newDisplay();
		const displayActor: Actor = {
			kind: 'display',
			deviceId: display.id,
			capabilities: [],
			showNames: false,
		};
		for (const actor of [
			member.actor,
			appActor(),
			aiFor(admin.member.id as MemberId),
			displayActor,
		]) {
			expect(
				await codeOf(invoke('core.updateDisplay', { deviceId: display.id, name: 'Mine' }, actor)),
			).toBe('forbidden');
			expect(await codeOf(invoke('core.revokeDevice', { deviceId: display.id }, actor))).toBe(
				'forbidden',
			);
		}
		expect((await k.devices.list()).find((d) => d.id === display.id)?.name).toBe('Hallway');
	});
});

describe('credential routes record themselves', () => {
	it('writes one applied row with the operation id and the target, never the secret', async () => {
		await k.route('core.setMemberPassword').call({
			actor: admin.actor,
			params: { memberId: member.member.id },
			body: { email: 'leo@example.com', password: 'a long enough password' },
		});
		await k.route('core.signOutEverywhere').call({ actor: member.actor });
		expect(await auditOf('core.setMemberPassword')).toMatchObject([
			{ outcome: 'applied', target: member.member.id },
		]);
		expect(await auditOf('core.signOutEverywhere')).toMatchObject([
			{ outcome: 'applied', target: member.member.id },
		]);
		await k.audit.record(admin.actor, 'apps.createToken', 'app_token_x');
		expect(await auditOf('apps.createToken')).toMatchObject([{ target: 'app_token_x' }]);
		const all = JSON.stringify(
			await k.ctx.db.withTables<CoreTables>().selectFrom('core_audit_log').selectAll().execute(),
		);
		expect(all).not.toContain('a long enough password');
		expect(all).not.toContain('leo@example.com');
	});
});
