import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';
import { DEFAULT_LIST_ID } from '../src/server/store.ts';

const AI: Actor = { kind: 'ai', mode: 'conversation', source: 'assistant' };
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let hardwareId: string;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: 'UTC' }, systemActor('test'));
	admin = await k.member('admin', 'Ayşe');
	const made = await k.runner.invoke<{ id: string }>(
		'lists.createShoppingList',
		{ name: 'Hardware store' },
		admin.actor,
	);
	if (made.status !== 'applied') throw new Error('expected the list to be made');
	hardwareId = made.output.id;
});
afterEach(() => k.close());

const draftInputs = () =>
	k.route('core.listDrafts').call({ query: { limit: 50 }, actor: admin.actor }) as Promise<
		{ id: string; input: Record<string, unknown>; status: string }[]
	>;
const itemsOn = (listId: string) =>
	k.route('lists.listShoppingItems').call({ params: { listId }, actor: admin.actor }) as Promise<
		{ title: string }[]
	>;

describe('adding to a list by its name', () => {
	it('drafts the add for the list the person named, whatever the letter case', async () => {
		const result = await k.runner.invoke(
			'lists.addShoppingItems',
			// What the in-app assistant sent: the words of the person, no id.
			{ list: 'hardware STORE', items: [{ title: 'Picture wire' }] },
			AI,
		);
		expect(result.status).toBe('drafted');
		const [draft] = await draftInputs();
		expect(draft?.input).toMatchObject({ listId: hardwareId });
		// The draft holds the id, not the words, so a rename cannot send it elsewhere.
		expect(draft?.input).not.toHaveProperty('list');

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		expect((await itemsOn(hardwareId)).map((i) => i.title)).toEqual(['Picture wire']);
	});

	it('knows the list without a name by the words of the catalog, in every installed language', async () => {
		for (const word of ['Shopping list', 'groceries', 'Bakkal']) {
			const result = await k.runner.invoke(
				'lists.addShoppingItems',
				{ list: word, items: [{ title: 'Picture wire' }] },
				AI,
			);
			expect(result.status, word).toBe('drafted');
		}
		const drafts = await draftInputs();
		expect(drafts.map((d) => d.input.listId)).toEqual(Array(3).fill(DEFAULT_LIST_ID));
	});

	it('refuses a name that is not a list, and names the lists there are', async () => {
		for (const invented of ['Hardware', 'Grocery shopping']) {
			await expect(
				k.runner.invoke(
					'lists.addShoppingItems',
					{ list: invented, items: [{ title: 'Picture wire' }] },
					AI,
				),
			).rejects.toMatchObject({
				code: 'bad_request',
				message: `There is no list called '${invented}'. The lists are: Shopping list, Hardware store. Use one of these names, or omit the list for the default one.`,
			});
		}
		expect(await draftInputs()).toEqual([]);
	});

	it('finds the list made on install by its default name, and keeps an id over a name', async () => {
		const ok = await k.runner.invoke(
			'lists.addShoppingItems',
			{ list: 'shopping list', items: [{ title: 'Milk' }] },
			admin.actor,
		);
		expect(ok.status).toBe('applied');
		const both = await k.runner.invoke(
			'lists.addShoppingItems',
			{ listId: hardwareId, list: 'Nowhere', items: [{ title: 'Nails' }] },
			admin.actor,
		);
		expect(both.status).toBe('applied');
		expect((await itemsOn(hardwareId)).map((i) => i.title)).toEqual(['Nails']);
	});
});

describe('a list really named like the default list', () => {
	const makeMarket = async () => {
		const made = await k.runner.invoke<{ id: string }>(
			'lists.createShoppingList',
			{ name: 'Market' },
			admin.actor,
		);
		if (made.status !== 'applied') throw new Error('expected the list to be made');
		return made.output.id;
	};
	const addTo = (list: string) =>
		k.runner.invoke('lists.addShoppingItems', { list, items: [{ title: 'Picture wire' }] }, AI);

	it('is the one a name reaches; the default list answers only when no list has that name', async () => {
		const marketId = await makeMarket();
		await addTo('market');
		await addTo('Groceries');
		await addTo('Shopping list');
		const ids = (await draftInputs()).map((d) => d.input.listId);
		expect(ids.toSorted()).toEqual([marketId, DEFAULT_LIST_ID, DEFAULT_LIST_ID].toSorted());
		expect(ids.filter((id) => id === marketId)).toHaveLength(1);
	});

	it('is the only list a read by that name returns', async () => {
		const marketId = await makeMarket();
		const read = async (list: string) => {
			const result = await k.runner.invoke('lists.shoppingList', { list }, AI);
			if (result.status !== 'applied') throw new Error('expected a read');
			return (result.output as { lists: { id: string }[] }).lists.map((l) => l.id);
		};
		expect(await read('Market')).toEqual([marketId]);
		expect(await read('Groceries')).toEqual([DEFAULT_LIST_ID]);
	});

	it('leaves "Market" to the default list when no list is stored under it', async () => {
		expect((await addTo('Market')).status).toBe('drafted');
		expect((await draftInputs())[0]?.input).toMatchObject({ listId: DEFAULT_LIST_ID });
	});
});
