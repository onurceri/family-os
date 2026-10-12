import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';

let k: TestKernel;
let ayse: Awaited<ReturnType<TestKernel['member']>>;
let hardwareId: string;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists, assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Istanbul', locale: 'en' },
		systemActor('test'),
	);
	ayse = await k.member('admin', 'Ayşe');
	const made = await k.runner.invoke<{ id: string }>(
		'lists.createShoppingList',
		{ name: 'Hardware store' },
		ayse.actor,
	);
	if (made.status !== 'applied') throw new Error('expected the list');
	hardwareId = made.output.id;
});
afterEach(() => k.close());

async function ask(text: string) {
	const result = await k.runner.invoke<{ threadId: string }>(
		'assistant.sendMessage',
		{ text },
		ayse.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	return result.output;
}
const drafts = () =>
	k.route('core.listDrafts').call({ query: { limit: 50 }, actor: ayse.actor }) as Promise<
		{ input: Record<string, unknown> }[]
	>;

describe('adding to a list the person names', () => {
	it('drafts the add for "Hardware store" when the model sends the name it heard', async () => {
		// What the real model did: it called only the add tool, with the list's name.
		k.llm.respondChat([
			{
				tool: 'lists_addShoppingItems',
				input: { list: 'Hardware store', items: [{ title: 'Picture wire' }] },
			},
			{ text: 'Suggested: picture wire for the Hardware store list.' },
		]);
		await ask('Add picture wire to the Hardware store list');

		expect(k.llm.chatTrace[0]?.result).toContain('"status":"drafted"');
		expect(await drafts()).toMatchObject([{ input: { listId: hardwareId } }]);
	});

	it('refuses a list name that was invented and tells the model the real names', async () => {
		k.llm.respondChat([
			{
				tool: 'lists_addShoppingItems',
				input: { list: 'Grocery shopping', items: [{ title: 'Picture wire' }] },
			},
			{
				tool: 'lists_addShoppingItems',
				input: { list: 'Hardware', items: [{ title: 'Picture wire' }] },
			},
			{ text: 'There is no such list.' },
		]);
		await ask('Add picture wire to the Hardware store list');

		const first = k.llm.chatTrace[0]?.result ?? '';
		expect(first).toContain("There is no list called 'Grocery shopping'");
		expect(first).toContain('The lists are: Shopping list, Hardware store.');
		expect(k.llm.chatTrace[1]?.result).toContain("There is no list called 'Hardware'");
		expect(await drafts()).toEqual([]);
	});

	it('says which field held a handle it was never shown', async () => {
		k.llm.respondChat([
			{
				tool: 'lists_addShoppingItems',
				input: {
					listId: 'shop_list_01990000-0000-7000-8000-000000000000',
					items: [{ title: 'Picture wire' }],
				},
			},
			{ text: 'ok' },
		]);
		await ask('Add picture wire to the Hardware store list');
		const result = k.llm.chatTrace[0]?.result ?? '';
		expect(result).toContain("unknown reference in 'listId'");
		expect(result).toContain('Look the thing up again with a read tool');
	});
});
