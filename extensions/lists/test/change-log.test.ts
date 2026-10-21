import { type Actor, isFamosError, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';
import { DEFAULT_LIST_ID, tables } from '../src/server/store.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: { actor: Actor; member: { id: string } };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin');
});
afterEach(() => k.close());

async function applied<T>(actionId: string, input: unknown, options = {}): Promise<T> {
	const r = await k.runner.invoke<T>(actionId, input, admin.actor, options);
	if (r.status !== 'applied') throw new Error(`expected applied, got ${r.status}`);
	return r.output;
}
const log = async (since = 0) =>
	(await k.changes.since(since, admin.actor)).changes.map((c) => [c.entity, c.op]);
const listVersion = async () =>
	(
		await tables(k.ctx.db)
			.selectFrom('lists_shopping_lists')
			.select('version')
			.where('id', '=', DEFAULT_LIST_ID)
			.executeTakeFirstOrThrow()
	).version;
const itemRow = (id: string) =>
	tables(k.ctx.db)
		.selectFrom('lists_shopping_items')
		.select(['version', 'updated_at'])
		.where('id', '=', id)
		.executeTakeFirstOrThrow();

describe('shopping in the change log', () => {
	it('names the items that changed and the list that shows how many are open', async () => {
		const added = await applied<{ addedIds: string[] }>('lists.addShoppingItems', {
			items: [{ title: 'Milk' }, { title: 'Bread' }],
		});
		const page = await k.changes.since(0, admin.actor);
		expect(page.changes.filter((c) => c.entity === 'shopping_item').map((c) => c.id)).toEqual(
			added.addedIds,
		);
		expect(page.changes.filter((c) => c.entity === 'shopping_list')).toEqual([
			expect.objectContaining({ id: DEFAULT_LIST_ID, op: 'upsert' }),
		]);
	});

	it('leaves a tombstone for a removed item and for items cleared after buying', async () => {
		const { addedIds } = await applied<{ addedIds: string[] }>('lists.addShoppingItems', {
			items: [{ title: 'Milk' }, { title: 'Bread' }, { title: 'Eggs' }],
		});
		const [milk, bread, eggs] = addedIds as [string, string, string];
		const seen = (await k.changes.head()) as number;
		await applied('lists.deleteShoppingItem', { id: milk });
		await applied('lists.checkShoppingItem', { id: bread, done: true });
		await applied('lists.clearBought', { listId: DEFAULT_LIST_ID });
		const page = await k.changes.since(seen, admin.actor);
		const items = Object.fromEntries(
			page.changes.filter((c) => c.entity === 'shopping_item').map((c) => [c.id, c.op]),
		);
		expect(items).toEqual({ [milk]: 'delete', [bread]: 'delete' });
		expect(items[eggs]).toBeUndefined();
	});

	it('raises the list version when an item is added, ticked or removed', async () => {
		expect(await listVersion()).toBe(0);
		const { addedIds } = await applied<{ addedIds: string[] }>('lists.addShoppingItems', {
			items: [{ title: 'Milk' }],
		});
		const added = await listVersion();
		expect(added).toBeGreaterThan(0);
		await applied('lists.checkShoppingItem', { id: addedIds[0], done: true });
		expect(await listVersion()).toBeGreaterThan(added);
	});

	it('refuses a conditional tick on an item that moved on', async () => {
		const { addedIds } = await applied<{ addedIds: string[] }>('lists.addShoppingItems', {
			items: [{ title: 'Milk' }],
		});
		const id = addedIds[0] as string;
		expect((await itemRow(id)).version).toBe(0);
		await applied('lists.updateShoppingItem', { id, quantity: '2' });
		const error = await k.runner
			.invoke('lists.checkShoppingItem', { id, done: true }, admin.actor, { ifMatch: 0 })
			.catch((e: unknown) => e);
		expect(isFamosError(error) && error.code).toBe('precondition_failed');
		expect((await itemRow(id)).version).toBe(1);
		await applied('lists.checkShoppingItem', { id, done: true }, { ifMatch: 1 });
	});

	it('removing a list is a delete of the list', async () => {
		const created = await applied<{ id: string }>('lists.createShoppingList', { name: 'Hardware' });
		await applied('lists.archiveShoppingList', { id: created.id });
		const rows = (await k.changes.since(0, admin.actor)).changes;
		expect(rows.find((c) => c.id === created.id)).toMatchObject({
			entity: 'shopping_list',
			op: 'delete',
		});
	});
});

describe('tasks in the change log', () => {
	it('records a task, then its removal as a delete', async () => {
		const task = await applied<{ id: string }>('lists.addTask', { title: 'Pay the fee' });
		expect(await log()).toEqual([['task', 'upsert']]);
		await applied('lists.deleteTask', { id: task.id });
		expect(await log()).toEqual([['task', 'delete']]);
	});

	it('counts every write of a task', async () => {
		const task = await applied<{ id: string }>('lists.addTask', { title: 'Pay the fee' });
		const version = () =>
			tables(k.ctx.db)
				.selectFrom('lists_tasks')
				.select('version')
				.where('id', '=', task.id)
				.executeTakeFirstOrThrow()
				.then((r) => r.version);
		expect(await version()).toBe(0);
		await applied('lists.completeTask', { id: task.id });
		expect(await version()).toBe(1);
	});
});

describe('taking back a completion in the change log', () => {
	it('tells a reader the task changed, as the finished record is gone', async () => {
		const task = await applied<{ id: string }>('lists.addTask', { title: 'Call the school' });
		await applied('lists.completeTask', { id: task.id });
		const seen = await k.changes.head();
		await applied('lists.reopenTask', { id: task.id });
		const page = await k.changes.since(seen, admin.actor);
		expect(page.changes.map((c) => [c.entity, c.id, c.op])).toEqual([['task', task.id, 'upsert']]);
		const display: Actor = { kind: 'display', deviceId: 'd1', capabilities: [], showNames: false };
		expect((await k.changes.since(seen, display)).changes).toEqual([]);
	});
});
