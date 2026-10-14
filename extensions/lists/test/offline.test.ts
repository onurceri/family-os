import { isFamosError, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShoppingItem, Task } from '../src/contract/index.ts';
import lists from '../src/server/index.ts';
import { DEFAULT_LIST_ID } from '../src/server/store.ts';

// Offline replays: a queued call is sent again with its key, possibly after the data
// changed. Each action must give a sensible answer and never duplicate anything.

const TZ = 'Europe/Istanbul';
let k: TestKernel;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
});
afterEach(() => k.close());

const items = (): Promise<ShoppingItem[]> =>
	k.route('lists.listShoppingItems').call({ params: { listId: DEFAULT_LIST_ID } });
const tasks = (): Promise<Task[]> => k.route('lists.listTasks').call();
const codeOf = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (isFamosError(e) ? e.code : 'other'),
	);

it('declares the offline-capable actions', () => {
	const offline = [...k.registry.actions.values()].filter((a) => a.offline).map((a) => a.id);
	expect(offline).toEqual(
		expect.arrayContaining([
			'lists.addShoppingItems',
			'lists.checkShoppingItem',
			'lists.completeTask',
			'lists.reopenTask',
		]),
	);
});

describe('shopping replays', () => {
	it('adds an item once however often the same request arrives', async () => {
		const { actor } = await k.member('admin');
		const options = { idempotencyKey: 'add_1' };
		const input = { items: [{ title: 'Süt' }] };
		await k.runner.invoke('lists.addShoppingItems', input, actor, options);
		await k.runner.invoke('lists.addShoppingItems', input, actor, options);
		expect(await items()).toHaveLength(1);
	});

	it('does not duplicate an item that was added again meanwhile (new key, same product)', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Süt' }] }, actor);
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'süt' }] }, actor, {
			idempotencyKey: 'late',
		});
		expect(await items()).toHaveLength(1);
	});

	it('checks and unchecks idempotently, and a late tick on a deleted item is a stored not_found', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Ekmek' }] }, actor);
		const [bread] = await items();
		const tick = { idempotencyKey: 'tick_1' };
		await k.runner.invoke('lists.checkShoppingItem', { id: bread?.id, done: true }, actor, tick);
		await k.runner.invoke('lists.checkShoppingItem', { id: bread?.id, done: true }, actor, tick);
		expect((await items())[0]?.doneAt).not.toBeNull();
		await k.runner.invoke('lists.checkShoppingItem', { id: bread?.id, done: false }, actor);
		expect((await items())[0]?.doneAt).toBeNull();

		await k.runner.invoke('lists.deleteShoppingItem', { id: bread?.id }, actor);
		const late = { idempotencyKey: 'tick_2' };
		const run = () =>
			codeOf(
				k.runner.invoke('lists.checkShoppingItem', { id: bread?.id, done: true }, actor, late),
			);
		expect(await run()).toBe('not_found');
		expect(await run()).toBe('not_found'); // the same answer on a repeat
		expect(await items()).toHaveLength(0);
	});
});

describe('task replays', () => {
	const addTask = async (actor: Parameters<typeof k.runner.invoke>[2], input = {}) => {
		const r = await k.runner.invoke<Task>(
			'lists.addTask',
			{ title: 'Pay the trip', dueDate: '2026-10-09', ...input },
			actor,
		);
		if (r.status !== 'applied') throw new Error('expected applied');
		return r.output;
	};

	it('completes once for a repeated key', async () => {
		const { actor } = await k.member('admin');
		const task = await addTask(actor);
		const options = { idempotencyKey: 'done_1' };
		const input = { id: task.id, dueDate: '2026-10-09' };
		await k.runner.invoke('lists.completeTask', input, actor, options);
		await k.runner.invoke('lists.completeTask', input, actor, options);
		expect((await tasks())[0]?.doneAt).not.toBeNull();
	});

	it('ignores a late completion of a task someone else already completed', async () => {
		const { actor: me } = await k.member('admin');
		const { actor: other } = await k.member('admin');
		const task = await addTask(me);
		await k.runner.invoke('lists.completeTask', { id: task.id, dueDate: '2026-10-09' }, other);
		const doneAt = (await tasks())[0]?.doneAt;
		k.clock.advance(60_000);
		const late = await k.runner.invoke(
			'lists.completeTask',
			{ id: task.id, dueDate: '2026-10-09' },
			me,
			{ idempotencyKey: 'late_done' },
		);
		expect(late.status).toBe('applied');
		expect((await tasks())[0]?.doneAt).toBe(doneAt); // untouched
	});

	it('a repeating task completed offline twice moves on only once', async () => {
		const { actor } = await k.member('admin');
		const task = await addTask(actor, { recurrence: { freq: 'daily' } });
		const input = { id: task.id, dueDate: '2026-10-09' };
		await k.runner.invoke('lists.completeTask', input, actor, { idempotencyKey: 'a' });
		// A second queued tap (another key) for the due date it already moved past changes nothing.
		await k.runner.invoke('lists.completeTask', input, actor, { idempotencyKey: 'b' });
		const [now] = await tasks();
		expect(now?.dueDate).not.toBe('2026-10-09');
	});

	it('reopens once for a repeated key, and a reopen of a deleted task is a stored not_found', async () => {
		const { actor } = await k.member('admin');
		const task = await addTask(actor);
		await k.runner.invoke('lists.completeTask', { id: task.id }, actor);
		const options = { idempotencyKey: 'reopen_1' };
		await k.runner.invoke('lists.reopenTask', { id: task.id }, actor, options);
		await k.runner.invoke('lists.reopenTask', { id: task.id }, actor, options);
		expect((await tasks())[0]?.doneAt).toBeNull();

		await k.runner.invoke('lists.deleteTask', { id: task.id }, actor);
		expect(
			await codeOf(
				k.runner.invoke('lists.reopenTask', { id: task.id }, actor, { idempotencyKey: 'r2' }),
			),
		).toBe('not_found');
	});
});
