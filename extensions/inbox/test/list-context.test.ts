import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, mention, type TestKernel, understood } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import inbox from '../src/server/index.ts';
import { namesRecordBadly } from '../src/server/understand/pipeline.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let hardwareId: string;
let bulbs: { id: string };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin', 'Ayşe');
	const made = await k.runner.invoke<{ id: string }>(
		'lists.createShoppingList',
		{ name: 'Hardware store' },
		admin.actor,
	);
	if (made.status !== 'applied') throw new Error('expected the list');
	hardwareId = made.output.id;
	const add = await k.runner.invoke<{ items: { id: string }[] }>(
		'lists.addShoppingItems',
		{ listId: hardwareId, items: [{ title: 'E27 light bulbs', quantity: '4' }] },
		admin.actor,
	);
	if (add.status !== 'applied') throw new Error('expected the add');
	bulbs = add.output.items[0] as { id: string };
	await k.runner.invoke('lists.addTask', { title: 'Pay the fee' }, admin.actor);
});
afterEach(() => k.close());

const TEXT = 'Got the E27 light bulbs already, tick them off the Hardware store list';
const read = async (text = TEXT) => {
	await k.route('inbox.createItem').call({
		body: { channel: 'share', text },
		files: [],
		actor: admin.actor,
	});
	await k.worker.drain();
};
const drafts = (): Promise<{ id: string; actionId: string; input: Record<string, unknown> }[]> =>
	k.route('core.listDrafts').call({
		query: { sourceKind: 'inbox', limit: 50 },
		actor: admin.actor,
	});
const item = async () =>
	(
		(await k.route('inbox.listItems').call({ query: { limit: 5 }, actor: admin.actor })) as {
			proposals: number;
			skipped: number;
			skippedUnknown: number;
		}[]
	)[0];

describe('open shopping items and tasks in the prompt', () => {
	it('lists them by name with their list, and never a handle or an id', async () => {
		k.llm.respond(understood([], { label: 'x' }));
		await read();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('Shopping items still to buy:');
		expect(system).toContain('- E27 light bulbs (4, list: Hardware store)');
		expect(system).toContain('Open tasks:');
		expect(system).toMatch(/- Pay the fee(\n|$)/);
		expect(JSON.stringify(k.llm.calls)).not.toMatch(/shop_item|task:1|task_[0-9a-f]{8}/);
	});

	it('leaves a ticked-off item out', async () => {
		await k.runner.invoke('lists.checkShoppingItem', { id: bulbs.id, done: true }, admin.actor);
		k.llm.respond(understood([], { label: 'x' }));
		await read();
		expect(k.llm.calls[0]?.system).not.toContain('- E27 light bulbs');
	});
});

describe('ticking something off from a shared message', () => {
	const bought = (target: string, place?: string) =>
		understood([mention('lists.bought', { target, ...(place && { place }) })]);

	it('turns "got the light bulbs already" into a draft that ticks the listed item', async () => {
		k.llm.respond(bought('E27 light bulbs', 'Hardware store'));
		await read();
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'lists.checkShoppingItem',
			input: { id: bulbs.id, done: true, label: 'E27 light bulbs' },
		});
		expect(await item()).toMatchObject({ proposals: 1, skipped: 0, skippedUnknown: 0 });

		await k.runner.approveDraft(draft?.id ?? '', admin.actor);
		const onList = (await k.route('lists.listShoppingItems').call({
			params: { listId: hardwareId },
			actor: admin.actor,
		})) as { title: string; doneAt: number | null }[];
		expect(onList).toMatchObject([{ title: 'E27 light bulbs', doneAt: expect.any(Number) }]);
	});

	it('leaves out a tick-off for an item that is not listed, and says it pointed at nothing real', async () => {
		k.llm.respond(bought('garden hose'));
		await read('Got the garden hose already');
		expect(await drafts()).toEqual([]);
		expect(await item()).toMatchObject({ proposals: 0, skipped: 1, skippedUnknown: 1 });
	});

	it('leaves out a tick-off aimed at a similar item the text never names', async () => {
		const add = await k.runner.invoke<{ items: { id: string }[] }>(
			'lists.addShoppingItems',
			{
				listId: hardwareId,
				items: [{ title: 'Picture hooks' }, { title: 'Picture wire' }],
			},
			admin.actor,
		);
		if (add.status !== 'applied') throw new Error('expected the add');
		// The text names the picture wire; a model once ticked off the hooks.
		k.llm.respond(bought('Picture hooks'));
		await read('Got the picture wire already, tick it off the Hardware store list');
		expect(k.llm.calls[0]?.system).toContain('- Picture hooks');
		expect(await drafts()).toEqual([]);
		expect(await item()).toMatchObject({ proposals: 0, skipped: 1, skippedUnknown: 1 });
	});

	it('keeps a tick-off whose item the text names in other order and plural', async () => {
		k.llm.respond(bought('light bulb E27'));
		await read('Got the light bulb E27 already');
		expect(await drafts()).toHaveLength(1);
	});

	it('tells an unlisted item from an incomplete suggestion', async () => {
		k.llm.respond(
			understood([
				// Not on the lists.
				mention('lists.taskDone', { target: 'the library fine' }),
				// Incomplete: no title.
				mention('lists.task', { notes: 'The fee is paid' }),
			]),
		);
		await read('The library fine is paid. The fee is paid');
		expect(await item()).toMatchObject({ proposals: 0, skipped: 2, skippedUnknown: 1 });
	});
});

describe('which rejected inputs pointed at a record', () => {
	it('is true when the id field failed, not when another field did', () => {
		expect(namesRecordBadly({ properties: { id: { errors: ['Invalid'] } } })).toBe(true);
		expect(namesRecordBadly({ properties: { recordId: { errors: ['Invalid'] } } })).toBe(true);
		expect(namesRecordBadly({ properties: { title: { errors: ['Required'] } } })).toBe(false);
		expect(namesRecordBadly(null)).toBe(false);
	});
});
