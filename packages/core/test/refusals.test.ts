import { type Actor, isFamosError } from '@famos/sdk';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel();
	admin = await k.member('admin');
});
afterEach(() => k.close());

/** Every row of every table, so a refused call that wrote anything shows up. */
async function snapshot(): Promise<Record<string, unknown[]>> {
	const names = await sql<{ name: string }>`
		select name from sqlite_master
		where type = 'table' and name not like 'sqlite_%' order by name`.execute(k.ctx.db);
	const out: Record<string, unknown[]> = {};
	for (const { name } of names.rows) {
		const rows = await sql<unknown>`select * from ${sql.table(name)}`.execute(k.ctx.db);
		out[name] = rows.rows;
	}
	return out;
}

async function outcome(id: string, actor: Actor): Promise<string> {
	try {
		// What is refused whatever the input is refused before the input is read.
		const r = (await k.runner.invoke(id, {}, actor)) as { status: string };
		return r.status;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
}

/** The data-changing core actions that name a capability to hold. */
function guarded() {
	return [...k.registry.actions.values()].filter(
		(a) =>
			a.id.startsWith('core.') &&
			a.readOnly !== true &&
			a.expose !== 'internal' &&
			typeof a.requires === 'string',
	);
}

describe('core actions that need a capability refuse callers who do not hold it', () => {
	it('lists the actions it covers, so a new one cannot slip by unnoticed', () => {
		const ids = guarded().map((a) => a.id);
		expect(ids.length).toBeGreaterThan(60);
		for (const id of [
			'core.updateApp',
			'core.revokeAppToken',
			'core.revokeApp',
			'core.pauseApp',
			'core.resumeApp',
			'core.createApp',
			'core.updateDisplay',
			'core.revokeDevice',
			'core.confirmDisplayPairing',
			'core.updateRole',
			'core.deleteRole',
			'core.createRole',
			'core.updateMember',
			'core.archiveMember',
			'core.createMember',
		])
			expect(ids).toContain(id);
	});

	it('refuses a display, whatever it may see, and changes nothing', async () => {
		const display: Actor = {
			kind: 'display',
			deviceId: 'dev_1',
			capabilities: k.access.capabilities.map((c) => c.id),
			showNames: true,
		};
		const before = await snapshot();
		for (const a of guarded()) {
			expect(await outcome(a.id, display), a.id).toBe('forbidden');
		}
		expect(await snapshot()).toEqual(before);
	});

	it('refuses a member whose role lacks the capability, and changes nothing', async () => {
		const before = await snapshot();
		let refused = 0;
		for (const roleId of ['member', 'supervised', 'guest']) {
			const who = await k.member(roleId);
			const mid = await snapshot();
			for (const a of guarded()) {
				if (k.access.can(who.actor, a.requires as string)) continue;
				refused++;
				expect(await outcome(a.id, who.actor), `${a.id} as ${roleId}`).toBe('forbidden');
			}
			expect(await snapshot()).toEqual(mid);
		}
		expect(refused).toBeGreaterThan(100);
		// Only the members this test added differ from the start.
		expect(Object.keys(await snapshot())).toEqual(Object.keys(before));
	});

	it('refuses a PIN sign-in and an app for every critical capability, and changes nothing', async () => {
		const pin: Actor = { ...admin.actor, pin: true };
		const app: Actor = {
			kind: 'app',
			appId: 'app_0198c2a0-0000-7000-8000-000000000001',
			roleId: 'admin',
			mode: 'apply',
		};
		const before = await snapshot();
		let checked = 0;
		for (const a of guarded()) {
			const cap = k.access.capabilities.find((c) => c.id === a.requires);
			if (cap?.critical !== true) continue;
			checked++;
			expect(await outcome(a.id, pin), `${a.id} by PIN`).toBe('forbidden');
			expect(await outcome(a.id, app), `${a.id} by an app`).toBe('forbidden');
		}
		expect(checked).toBeGreaterThan(20);
		expect(await snapshot()).toEqual(before);
	});

	it('never lets the AI run or propose a critical action', async () => {
		const ai: Actor = { kind: 'ai', mode: 'agent', source: 'mcp' };
		const before = await snapshot();
		for (const a of guarded()) {
			const cap = k.access.capabilities.find((c) => c.id === a.requires);
			if (cap?.critical !== true) continue;
			expect(await outcome(a.id, ai), a.id).toBe('forbidden');
		}
		expect(await snapshot()).toEqual(before);
		expect(
			await k.ctx.db.withTables<CoreTables>().selectFrom('core_drafts').select('id').execute(),
		).toEqual([]);
	});
});
