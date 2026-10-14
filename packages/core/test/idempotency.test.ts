import { FamosError, isFamosError } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notesExtension] });
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

	it('ignores keys for actors other than members', async () => {
		await k.runner.invoke(
			'notes.addNote',
			{ body: 'x' },
			{ kind: 'system', source: 'test' },
			{ idempotencyKey: 'sys' },
		);
		expect(await keyRows()).toHaveLength(0);
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
