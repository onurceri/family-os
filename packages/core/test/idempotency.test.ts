import {
	type Actor,
	defineAction,
	defineCapability,
	FamosError,
	isFamosError,
	type MemberId,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreTables } from '../src/tables.ts';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// An action the AI may propose, so an agent and a member can send the same key to it.
const jotEdit = defineCapability({ id: 'jots.edit', label: 'jots:cap', level: 'edit' });
const addJot = defineAction({
	id: 'jots.addJot',
	title: 'Add a jot',
	input: z.object({ body: z.string().min(1) }),
	output: z.object({}),
	approval: { unless: jotEdit.id },
	ai: { description: 'Adds a jot.' },
	async run() {
		return {};
	},
});
const jots = defineTestExtension({ id: 'jots', actions: [addJot], capabilities: [jotEdit] });

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notesExtension, jots] });
});
afterEach(() => k.close());

const count = async () => {
	const r = await k.runner.invoke<{ count: number }>(
		'notes.countNotes',
		{},
		{ kind: 'ai', mode: 'agent', source: 'test' },
	);
	return r.status === 'applied' ? r.output.count : -1;
};
const keyRows = () =>
	k.ctx.db.withTables<CoreTables>().selectFrom('core_idempotency').selectAll().execute();
const codeOf = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (isFamosError(e) ? e.code : 'other'),
	);

describe('idempotency keys', () => {
	it('runs once for a repeated key and replays the first result', async () => {
		const { actor } = await k.member('member');
		let replays = 0;
		const options = { idempotencyKey: 'key_1', onReplay: () => replays++ };
		const first = await k.runner.invoke('notes.addNote', { body: 'milk' }, actor, options);
		const second = await k.runner.invoke('notes.addNote', { body: 'milk' }, actor, options);
		expect(second).toEqual(first);
		expect(replays).toBe(1);
		expect(await count()).toBe(1);
		expect(await keyRows()).toHaveLength(1);
	});

	it('refuses a key used for a different action', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke('notes.addNote', { body: 'a' }, actor, { idempotencyKey: 'k' });
		const error = await k.runner
			.invoke('notes.countNotes', {}, actor, { idempotencyKey: 'k' })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FamosError);
		expect((error as FamosError).code).toBe('idempotency_mismatch');
	});

	it('keeps keys independent per member', async () => {
		const { actor: a } = await k.member('member');
		const { actor: b } = await k.member('member');
		await k.runner.invoke('notes.addNote', { body: 'a' }, a, { idempotencyKey: 'same' });
		await k.runner.invoke('notes.addNote', { body: 'b' }, b, { idempotencyKey: 'same' });
		expect(await count()).toBe(2);
	});

	it('replays a validation error instead of running a corrected request', async () => {
		const { actor } = await k.member('member');
		const options = { idempotencyKey: 'bad' };
		expect(await codeOf(k.runner.invoke('notes.addNote', { body: '' }, actor, options))).toBe(
			'bad_request',
		);
		expect(await codeOf(k.runner.invoke('notes.addNote', { body: 'ok' }, actor, options))).toBe(
			'bad_request',
		);
		expect(await count()).toBe(0);
	});

	it('replays a refusal (forbidden) too', async () => {
		const { actor } = await k.member('guest');
		const options = { idempotencyKey: 'no' };
		expect(await codeOf(k.runner.invoke('notes.addNote', { body: 'x' }, actor, options))).toBe(
			'forbidden',
		);
		expect((await keyRows())[0]?.status).toBe(403);
		expect(await codeOf(k.runner.invoke('notes.addNote', { body: 'x' }, actor, options))).toBe(
			'forbidden',
		);
	});

	it('rolls the key back with the action, so a failed request can be retried', async () => {
		const { actor } = await k.member('member');
		const options = { idempotencyKey: 'retry' };
		expect(
			await codeOf(k.runner.invoke('notes.addNote', { body: 'x', fail: true }, actor, options)),
		).toBe('other');
		expect(await keyRows()).toHaveLength(0);
		expect(await count()).toBe(0);
		await k.runner.invoke('notes.addNote', { body: 'x' }, actor, options);
		expect(await count()).toBe(1);
	});

	it('stores a drafted result: the same key proposes one draft', async () => {
		const { actor } = await k.member('supervised');
		const options = { idempotencyKey: 'draft' };
		const first = await k.runner.invoke('notes.addNote', { body: 'x' }, actor, options);
		const second = await k.runner.invoke('notes.addNote', { body: 'x' }, actor, options);
		expect(first.status).toBe('drafted');
		expect(second).toEqual(first);
	});

	it('keeps no keys for the system or a display', async () => {
		await k.runner.invoke(
			'notes.addNote',
			{ body: 'x' },
			{ kind: 'system', source: 'test' },
			{ idempotencyKey: 'sys' },
		);
		expect(await keyRows()).toHaveLength(0);
	});

	it('keeps a member and an AI agent working for that member apart, though the key is the same', async () => {
		const { actor, member } = await k.member('member');
		const agent: Actor = {
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			sourceId: 'api_token_1',
			onBehalfOf: member.id as MemberId,
			roleId: member.roleId,
		};
		const options = { idempotencyKey: 'shared' };
		const own = await k.runner.invoke('jots.addJot', { body: 'mine' }, actor, options);
		let replays = 0;
		// The agent's call with the member's key is a new call, not the member's answer replayed.
		const theirs = await k.runner.invoke('jots.addJot', { body: 'agent' }, agent, {
			...options,
			onReplay: () => replays++,
		});
		expect(replays).toBe(0);
		expect(theirs.status).toBe('drafted');
		expect(theirs).not.toEqual(own);
		expect(own.status).toBe('applied');
		// Each is replayed to itself only.
		expect(await k.runner.invoke('jots.addJot', { body: 'mine' }, actor, options)).toEqual(own);
		expect(await k.runner.invoke('jots.addJot', { body: 'agent' }, agent, options)).toEqual(theirs);
		const rows = await keyRows();
		expect(rows.map((r) => r.principal).sort()).toEqual(
			[`member:${member.id}`, `ai:mcp:api_token_1/member:${member.id}`].sort(),
		);
	});

	it('keeps two agents of the same source apart, and one agent per member it works for', async () => {
		const { member: a } = await k.member('member');
		const { member: b } = await k.member('member');
		const agent = (who: typeof a, sourceId: string): Actor => ({
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			sourceId,
			onBehalfOf: who.id as MemberId,
			roleId: who.roleId,
		});
		const options = { idempotencyKey: 'same' };
		await k.runner.invoke('jots.addJot', { body: '1' }, agent(a, 't1'), options);
		await k.runner.invoke('jots.addJot', { body: '2' }, agent(a, 't2'), options);
		await k.runner.invoke('jots.addJot', { body: '3' }, agent(b, 't1'), options);
		expect(await keyRows()).toHaveLength(3);
	});

	it('answers a member from a key stored before principals existed', async () => {
		const { actor } = await k.member('member');
		const first = await k.runner.invoke('notes.addNote', { body: 'old' }, actor, {
			idempotencyKey: 'legacy',
		});
		await k.ctx.db
			.withTables<CoreTables>()
			.updateTable('core_idempotency')
			.set({ principal: null })
			.execute();
		expect(
			await k.runner.invoke('notes.addNote', { body: 'old' }, actor, { idempotencyKey: 'legacy' }),
		).toEqual(first);
		expect(await count()).toBe(1);
	});

	it('deletes keys older than 7 days with the daily job, which schedules itself again', async () => {
		const { actor } = await k.member('member');
		await k.runner.invoke('notes.addNote', { body: 'x' }, actor, { idempotencyKey: 'old' });
		k.clock.advance(6 * 24 * 3600_000);
		await k.runner.invoke('notes.addNote', { body: 'y' }, actor, { idempotencyKey: 'newer' });
		k.clock.advance(2 * 24 * 3600_000);
		expect(await k.worker.drain()).toBeGreaterThanOrEqual(1);
		expect((await keyRows()).map((r) => r.key)).toEqual(['newer']);
		// The next run was queued for the following day and finds the newer key old by then.
		k.clock.advance(6 * 24 * 3600_000);
		expect(await k.worker.drain()).toBeGreaterThanOrEqual(1);
		expect(await keyRows()).toHaveLength(0);
	});
});
