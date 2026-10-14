import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
const AI: Actor = { kind: 'ai', mode: 'conversation', source: 'assistant' };
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-12', '10:00', TZ));
	admin = await k.member('admin', 'Ayse');
	await k.runner.invoke(
		'lists.addShoppingItems',
		{ items: [{ title: 'Oat milk' }, { title: 'Bread' }, { title: 'Milk' }] },
		admin.actor,
	);
});
afterEach(() => k.close());

type Listed = { lists: { items: { id: string; title: string; bought: boolean }[] }[] };

async function shoppingList(): Promise<Record<string, { id: string; bought: boolean }>> {
	const result = await k.runner.invoke<Listed>('lists.shoppingList', {}, AI);
	if (result.status !== 'applied') throw new Error('expected applied');
	return Object.fromEntries(
		result.output.lists
			.flatMap((l) => l.items)
			.map((i) => [i.title, { id: i.id, bought: i.bought }]),
	);
}

describe('shopping items an AI points at', () => {
	it('lists what was bought in the last week as bought, and older purchases not at all', async () => {
		const items = await shoppingList();
		await k.runner.invoke(
			'lists.checkShoppingItem',
			{ id: items.Milk?.id, done: true },
			admin.actor,
		);
		expect(await shoppingList()).toMatchObject({
			'Oat milk': { bought: false },
			Bread: { bought: false },
			Milk: { bought: true },
		});
		k.clock.set(epochOf('2026-10-20', '10:00', TZ));
		expect(Object.keys(await shoppingList())).toEqual(['Oat milk', 'Bread']);
	});

	it('finds items by another form of the word searched for, without loosening which one a change names', async () => {
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Breadsticks' }] },
			admin.actor,
		);
		const found = await k.runner.invoke<Listed>('lists.shoppingList', { text: 'bread' }, AI);
		if (found.status !== 'applied') throw new Error('expected applied');
		expect(found.output.lists.flatMap((l) => l.items.map((i) => i.title)).sort()).toEqual([
			'Bread',
			'Breadsticks',
		]);
		const items = await shoppingList();
		await expect(
			k.runner.invoke(
				'lists.deleteShoppingItem',
				{ id: items.Breadsticks?.id, label: 'Bread' },
				AI,
				{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
			),
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('refuses to remove the closest item when the named one is not on the list', async () => {
		// Real mistake: "Remove the anchovies" sent an unrelated item with the label "4".
		const items = await shoppingList();
		for (const label of ['4', 'anchovies', undefined]) {
			await expect(
				k.runner.invoke(
					'lists.deleteShoppingItem',
					{ id: items.Bread?.id, ...(label && { label }) },
					AI,
				),
			).rejects.toMatchObject({ code: 'conflict' });
		}
		const bread = await k.runner.invoke(
			'lists.deleteShoppingItem',
			{ id: items.Bread?.id, label: 'the bread' },
			AI,
		);
		expect(bread.status).toBe('drafted');
	});

	it('does not tick off a bought item again, so "Milk" cannot slide onto "Oat milk"', async () => {
		// Real mistake: "Tick off the milk and the oat milk" made two drafts on the Oat milk row,
		// because the bought Milk was not shown.
		const items = await shoppingList();
		await k.runner.invoke(
			'lists.checkShoppingItem',
			{ id: items.Milk?.id, done: true },
			admin.actor,
		);
		await expect(
			k.runner.invoke(
				'lists.checkShoppingItem',
				{ id: items.Milk?.id, done: true, label: 'Milk' },
				AI,
			),
		).rejects.toMatchObject({ message: expect.stringContaining('Milk is already ticked off.') });
		await expect(
			k.runner.invoke(
				'lists.checkShoppingItem',
				{ id: items['Oat milk']?.id, done: false, label: 'Oat milk' },
				AI,
			),
		).rejects.toMatchObject({
			message: expect.stringContaining('Oat milk is already on the list, not ticked off.'),
		});
		const oat = await k.runner.invoke(
			'lists.checkShoppingItem',
			{ id: items['Oat milk']?.id, done: true, label: 'Oat milk' },
			AI,
		);
		expect(oat.status).toBe('drafted');
	});

	it('shows the real name on the draft of a person who sent only the id', async () => {
		const items = await shoppingList();
		const supervised = await k.member('supervised', 'Mina');
		const result = await k.runner.invoke(
			'lists.deleteShoppingItem',
			{ id: items.Bread?.id },
			supervised.actor,
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		const row = await k.ctx.db
			.withTables<{ core_drafts: { id: string; input: string } }>()
			.selectFrom('core_drafts')
			.select('input')
			.where('id', '=', result.draftId)
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.input)).toMatchObject({ label: 'Bread' });
	});
});
