import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';
import { proposalLines } from '../src/server/turn.ts';

type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Asker;

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [lists, assistant],
		translate: repoTranslate(),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Istanbul', locale: 'en' },
		systemActor('test'),
	);
	ayse = await k.member('admin', 'Ayşe');
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

async function answer(sent: { threadId: string }): Promise<string> {
	const detail = await k
		.route('assistant.getThread')
		.call({ params: { threadId: sent.threadId }, actor: ayse.actor });
	return (detail.messages.at(-1) as { content: string }).content;
}

const drafts = () =>
	k.ctx.db
		.withTables<{ core_drafts: { id: string; action_id: string; input: string } }>()
		.selectFrom('core_drafts')
		.selectAll()
		.execute();

async function add(title: string, listId?: string) {
	const made = await k.runner.invoke<{ items: { id: string }[] }>(
		'lists.addShoppingItems',
		{ items: [{ title }], ...(listId && { listId }) },
		ayse.actor,
	);
	if (made.status !== 'applied') throw new Error('expected applied');
	return made.output.items[0]?.id as string;
}

async function newList(name: string) {
	const made = await k.runner.invoke<{ id: string }>(
		'lists.createShoppingList',
		{ name },
		ayse.actor,
	);
	if (made.status !== 'applied') throw new Error('expected applied');
	return made.output.id;
}

describe('the answer never says something else than what was suggested', () => {
	it('names the real suggestion when the model claims it ticked items it only re-added', async () => {
		const milk = await add('Milk');
		const oat = await add('Oat milk');
		for (const id of [milk, oat]) {
			k.clock.advance(1000);
			await k.runner.invoke('lists.checkShoppingItem', { id, done: true }, ayse.actor);
		}
		k.llm.respondChat([
			{ tool: 'lists_shoppingList', input: {} },
			// Both are bought already, so the check is refused.
			{ tool: 'lists_checkShoppingItem', input: { id: 'shop_item:2', done: true, label: 'Milk' } },
			// Real model output: it put them back on the list instead and said it ticked them off.
			{
				tool: 'lists_addShoppingItems',
				input: { items: [{ title: 'Milk' }, { title: 'Oat milk' }], whenOnList: 'update' },
			},
			{ text: 'I have suggested ticking off milk and oat milk.' },
		]);
		const sent = await ask('Tick off the milk and the oat milk');

		const refusal = k.llm.chatTrace[1]?.result ?? '';
		expect(refusal).toContain('Milk is already ticked off.');
		expect(refusal).toContain('do not suggest anything else for it');

		const content = await answer(sent);
		expect(content).toContain('I have suggested ticking off milk and oat milk.');
		expect(content).toContain('Waiting for approval: Add shopping items: Milk, Oat milk');
		expect((await drafts()).map((d) => d.action_id)).toEqual(['lists.addShoppingItems']);
	});

	it('adds no line when nothing was suggested', async () => {
		k.llm.respondChat([{ text: 'Nothing to do.' }]);
		expect(await answer(await ask('Hello'))).toBe('Nothing to do.');
	});

	it('builds one line per suggestion, automatic ones worded as such', () => {
		const translate = (key: string, params?: Record<string, unknown>) =>
			`${key}|${JSON.stringify(params ?? {})}`;
		expect(
			proposalLines(
				[
					{
						title: 'Add a task',
						titleKey: 'lists:draft_title_add_task',
						subject: 'Call',
						automatic: false,
					},
					{ title: 'Remove an item', automatic: true },
				],
				translate,
			).split('\n'),
		).toEqual([
			'assistant:proposed_waiting|{"what":"lists:draft_title_add_task|{}: Call"}',
			'assistant:proposed_automatic|{"what":"Remove an item"}',
		]);
	});
});

describe('the list a request names', () => {
	it('is found by name and the item goes on it', async () => {
		const hardware = await newList('Hardware store');
		k.llm.respondChat([
			{ tool: 'lists_shoppingList', input: { list: 'Hardware store' } },
			{
				tool: 'lists_addShoppingItems',
				input: { listId: 'shop_list:1', items: [{ title: 'Picture wire' }] },
			},
			{ text: 'Suggested.' },
		]);
		await ask('Add picture wire to the Hardware store list');
		const found = k.llm.chatTrace[0]?.result ?? '';
		expect(found).toContain('Hardware store');
		expect(found).toContain('"id":"shop_list:1"');
		const [draft] = await drafts();
		expect(JSON.parse(draft?.input ?? '{}')).toMatchObject({ listId: hardware });
		await k.runner.approveDraft(draft?.id as string, ayse.actor);
		const items = await k.route('lists.listShoppingItems').call({ params: { listId: hardware } });
		expect(items.map((i: { title: string }) => i.title)).toEqual(['Picture wire']);
	});

	it('is read by its handle, and an item with a quantity lands on it', async () => {
		const scratch = await newList('V2 scratch');
		k.llm.respondChat([
			{ tool: 'lists_shoppingList', input: {} },
			{ tool: 'lists_shoppingList', input: { listId: 'shop_list:2' } },
			{
				tool: 'lists_addShoppingItems',
				input: { listId: 'shop_list:2', items: [{ title: 'Oat milk', quantity: '4 l' }] },
			},
			{ text: 'Suggested.' },
		]);
		await ask('Make it 4 l of oat milk on the V2 scratch list');
		const [all, one] = k.llm.chatTrace;
		expect(all?.result).toContain('V2 scratch');
		expect(one?.result).toContain('V2 scratch');
		expect(one?.result).not.toContain('Shopping list');
		const [draft] = await drafts();
		expect(JSON.parse(draft?.input ?? '{}')).toMatchObject({ listId: scratch });
	});

	it('tells the model to name the list it is given and to omit it otherwise', () => {
		const info = k.ctx.actions
			.aiCatalog({ local: true })
			.find((a) => a.id === 'lists.addShoppingItems');
		expect(info?.guidance).toContain('send the name as they said it in `list`');
		expect(info?.guidance).toContain('default list is used');
	});
});
