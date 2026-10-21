import type { Actor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShoppingItem, Task } from '../src/contract/index.ts';
import lists from '../src/server/index.ts';
import { DEFAULT_LIST_ID } from '../src/server/store.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await sql`insert into core_apps (id, name, role_id, mode, acts_for, created_at, updated_at)
		values ('app_home', 'Home Assistant', 'member', 'suggest', '[]', 0, 0)`.execute(k.ctx.db);
});
afterEach(() => k.close());

const suggesting: Actor = { kind: 'app', appId: 'app_home', roleId: 'member', mode: 'suggest' };

async function applied<T>(promise: Promise<{ status: string; output?: unknown }>): Promise<T> {
	const result = await promise;
	if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
	return result.output as T;
}

describe('suggestions a connected app makes about lists', () => {
	it('name the shopping item and the task a program changes by id alone', async () => {
		const admin = await k.member('admin');
		await applied(
			k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Bread' }] }, admin.actor),
		);
		const [item] = (await k
			.route('lists.listShoppingItems')
			.call({ params: { listId: DEFAULT_LIST_ID } })) as ShoppingItem[];
		const task = await applied<Task>(
			k.runner.invoke('lists.addTask', { title: 'Pay the school trip' }, admin.actor),
		);
		await applied(
			k.runner.invoke('lists.completeTask', { id: task.id, dueDate: null }, admin.actor),
		);
		await k.runner.invoke(
			'lists.updateShoppingItem',
			{ id: (item as ShoppingItem).id, quantity: '2' },
			suggesting,
		);
		await k.runner.invoke('lists.reopenTask', { id: task.id }, suggesting);
		const drafts = (await k.route('core.listDrafts').call({
			actor: admin.actor,
			query: { limit: 50 },
		})) as { actionId: string; subject: string | null }[];
		expect(drafts.map((d) => [d.actionId, d.subject]).toSorted()).toEqual([
			['lists.reopenTask', 'Pay the school trip'],
			['lists.updateShoppingItem', 'Bread'],
		]);
	});
});
