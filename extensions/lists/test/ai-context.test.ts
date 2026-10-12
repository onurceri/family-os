import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';

const AI: Actor = { kind: 'ai', source: 'inbox' };
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: 'UTC' }, systemActor('test'));
	admin = await k.member('admin', 'Ayşe');
});
afterEach(() => k.close());

const read = async (actionId: string) => {
	const result = await k.runner.invoke<{
		kind: string;
		items: { id: string; label: string; details?: string }[];
	}>(actionId, {}, AI);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};

describe('what the AI may point at on the lists', () => {
	it('gives open shopping items with the list they are on, not bought or removed ones', async () => {
		const made = await k.runner.invoke<{ id: string }>(
			'lists.createShoppingList',
			{ name: 'Hardware store' },
			admin.actor,
		);
		if (made.status !== 'applied') throw new Error('expected the list');
		const add = await k.runner.invoke<{ items: { id: string }[] }>(
			'lists.addShoppingItems',
			{
				listId: made.output.id,
				items: [{ title: 'E27 light bulbs', quantity: '4' }, { title: 'Glue' }, { title: 'Tape' }],
			},
			admin.actor,
		);
		if (add.status !== 'applied') throw new Error('expected the add');
		const [bulbs, glue, tape] = add.output.items as [
			{ id: string },
			{ id: string },
			{ id: string },
		];
		await k.runner.invoke('lists.checkShoppingItem', { id: glue.id, done: true }, admin.actor);
		await k.runner.invoke('lists.deleteShoppingItem', { id: tape.id }, admin.actor);
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Milk' }] }, admin.actor);

		const context = await read('lists.aiContext');
		expect(context.kind).toBe('shop_item');
		expect(context.items).toEqual([
			{ id: expect.any(String), label: 'Milk', details: 'list: Shopping list' },
			{ id: bulbs.id, label: 'E27 light bulbs', details: '4, list: Hardware store' },
		]);
	});

	it('cuts a long list at its oldest end, so the newest items and tasks always reach the model', async () => {
		for (let i = 1; i <= 205; i++) {
			k.clock.set(1_800_000_000_000 + i * 1000);
			await k.runner.invoke(
				'lists.addShoppingItems',
				{ items: [{ title: `Item ${i}` }] },
				admin.actor,
			);
			await k.runner.invoke('lists.addTask', { title: `Task ${i}` }, admin.actor);
		}
		const items = (await read('lists.aiContext')).items.map((i) => i.label);
		expect(items).toHaveLength(200);
		expect(items[0]).toBe('Item 205');
		expect(items).not.toContain('Item 5');
		const tasks = (await read('lists.aiContextTasks')).items.map((i) => i.label);
		expect(tasks).toHaveLength(200);
		expect(tasks[0]).toBe('Task 205');
		expect(tasks).not.toContain('Task 5');
	});

	it('gives open tasks only', async () => {
		const open = await k.runner.invoke<{ id: string }>(
			'lists.addTask',
			{ title: 'Pay the fee', dueDate: '2026-10-09' },
			admin.actor,
		);
		const done = await k.runner.invoke<{ id: string }>(
			'lists.addTask',
			{ title: 'Water plants' },
			admin.actor,
		);
		if (open.status !== 'applied' || done.status !== 'applied') throw new Error('expected tasks');
		await k.runner.invoke('lists.completeTask', { id: done.output.id }, admin.actor);

		const context = await read('lists.aiContextTasks');
		expect(context.kind).toBe('task');
		expect(context.items).toEqual([
			{ id: open.output.id, label: 'Pay the fee', details: 'due 2026-10-09' },
		]);
	});
});
