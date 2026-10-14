import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShoppingItem } from '../src/contract/index.ts';
import lists from '../src/server/index.ts';
import { DEFAULT_LIST_ID } from '../src/server/store.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
});
afterEach(() => k.close());

const items = (): Promise<ShoppingItem[]> =>
	k.route('lists.listShoppingItems').call({ params: { listId: DEFAULT_LIST_ID } });

async function enable(actionId: string, proposerCapability: string) {
	const { actor } = await k.member('admin');
	const result = await k.runner.invoke(
		'core.setAutoApproval',
		{ actionId, setting: { proposerCapability } },
		actor,
	);
	if (result.status !== 'applied') throw new Error('expected the setting');
}

describe('auto-approval for lists', () => {
	it('offers shopping items and tasks with the capabilities to pick from', async () => {
		const { actions } = await k.route('core.listAutoApproval').call();
		expect(
			actions.map((a: { actionId: string; choices: { value: string }[] }) => [
				a.actionId,
				a.choices.map((c) => c.value),
			]),
		).toEqual([
			['lists.addShoppingItems', ['lists.shopping.manage', 'lists.shopping.edit']],
			['lists.addTask', ['lists.tasks.edit']],
		]);
	});

	it('applies shopping items the assistant or the Inbox suggest for people who qualify', async () => {
		await enable('lists.addShoppingItems', 'lists.shopping.manage');
		const adult = (await k.member('member')).member;
		const child = (await k.member('supervised')).member;

		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Milk' }] },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
			{ draft: { sourceKind: 'inbox', sourceId: 'inbox_item_1', forMember: adult.id } },
		);
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Bread' }] },
			{
				kind: 'ai',
				mode: 'conversation',
				source: 'assistant',
				onBehalfOf: adult.id as never,
				roleId: 'member',
			},
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
		);
		// A child's suggestion waits for a person.
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Sweets' }] },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
			{ draft: { sourceKind: 'inbox', sourceId: 'inbox_item_2', forMember: child.id } },
		);
		await k.worker.drain();

		expect((await items()).map((i) => i.title).sort()).toEqual(['Bread', 'Milk']);
	});

	it('leaves what the AI suggests when no setting exists', async () => {
		const adult = (await k.member('member')).member;
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Milk' }] },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
			{ draft: { sourceKind: 'inbox', sourceId: 'inbox_item_1', forMember: adult.id } },
		);
		await k.worker.drain();
		expect(await items()).toEqual([]);
	});

	it('approves a task an adult has the assistant add for them', async () => {
		await enable('lists.addTask', 'lists.tasks.edit');
		const adult = (await k.member('member')).member;
		await k.runner.invoke(
			'lists.addTask',
			{ title: 'Call the school' },
			{
				kind: 'ai',
				mode: 'conversation',
				source: 'assistant',
				onBehalfOf: adult.id as never,
				roleId: 'member',
			},
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_2' } },
		);
		await k.worker.drain();
		const tasks = await k.route('lists.listTasks').call();
		expect(tasks.map((t: { title: string }) => t.title)).toEqual(['Call the school']);
	});
});
