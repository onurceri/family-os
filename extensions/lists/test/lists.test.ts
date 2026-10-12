import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShoppingItem, Task } from '../src/contract/index.ts';
import lists from '../src/server/index.ts';
import { DEFAULT_LIST_ID } from '../src/server/store.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'tr' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-06', '10:00', TZ)); // a Tuesday
});
afterEach(() => k.close());

const tasks = (): Promise<Task[]> => k.route('lists.listTasks').call();
const items = (listId = DEFAULT_LIST_ID): Promise<ShoppingItem[]> =>
	k.route('lists.listShoppingItems').call({ params: { listId } });

async function applied<T>(promise: Promise<{ status: string; output?: unknown }>): Promise<T> {
	const result = await promise;
	if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
	return result.output as T;
}

describe('tasks', () => {
	it('adds, completes and reopens a one-off task', async () => {
		const { actor, member } = await k.member('admin');
		const task = await applied<Task>(
			k.runner.invoke(
				'lists.addTask',
				{ title: 'Gezi ücretini öde', assigneeId: member.id, dueDate: '2026-10-09' },
				actor,
			),
		);
		expect(task).toMatchObject({ assigneeId: member.id, dueDate: '2026-10-09', doneAt: null });
		const done = await applied<Task>(
			k.runner.invoke('lists.completeTask', { id: task.id, dueDate: '2026-10-09' }, actor),
		);
		expect(done.doneAt).toBe(k.clock.now());
		expect(await tasks()).toHaveLength(1); // still visible as done for a week
		k.clock.advance(8 * 86_400_000);
		expect(await tasks()).toEqual([]);
		const reopened = await applied<Task>(
			k.runner.invoke('lists.reopenTask', { id: task.id }, actor),
		);
		expect(reopened).toMatchObject({ doneAt: null, dueDate: '2026-10-09' });
	});

	it('changes only the fields given, keeps the rest, and can be changed back', async () => {
		const { actor, member } = await k.member('admin');
		const task = await applied<Task>(
			k.runner.invoke(
				'lists.addTask',
				{
					title: 'Faturaları öde',
					notes: 'Elektrik ve su',
					dueDate: '2026-10-09',
					recurrence: { freq: 'monthly' },
				},
				actor,
			),
		);
		const { task: changed, before } = await applied<{
			task: Task;
			before: Record<string, string | null>;
		}>(
			k.runner.invoke(
				'lists.changeTask',
				{ id: task.id, assigneeId: member.id, dueDate: '2026-10-15', label: 'Faturaları öde' },
				actor,
			),
		);
		expect(changed).toMatchObject({
			title: 'Faturaları öde',
			notes: 'Elektrik ve su',
			assigneeId: member.id,
			dueDate: '2026-10-15',
		});
		expect(changed.recurrence).not.toBeNull();
		expect(before).toEqual({ assigneeId: null, dueDate: '2026-10-09' });
		const back = await applied<{ task: Task }>(
			k.runner.invoke('lists.changeTask', { id: task.id, ...before }, actor),
		);
		expect(back.task).toMatchObject({ assigneeId: null, dueDate: '2026-10-09' });
		await expect(
			k.runner.invoke('lists.changeTask', { id: task.id, dueDate: null }, actor),
		).rejects.toThrow(/repeating task needs a due date/);
	});

	it('lets the AI propose a change to a task, which waits for a person', async () => {
		const { actor, member } = await k.member('admin');
		const task = await applied<Task>(
			k.runner.invoke('lists.addTask', { title: 'Faturaları öde' }, actor),
		);
		const result = await k.runner.invoke(
			'lists.changeTask',
			{ id: task.id, assigneeId: member.id, dueDate: '2026-10-10' },
			{ kind: 'ai', source: 'assistant', onBehalfOf: member.id as never, roleId: 'admin' },
			{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
		);
		expect(result.status).toBe('drafted');
		expect((await tasks())[0]).toMatchObject({ assigneeId: null, dueDate: null });
		await k.runner.approveDraft((result as { draftId: string }).draftId, actor);
		expect((await tasks())[0]).toMatchObject({ assigneeId: member.id, dueDate: '2026-10-10' });
	});

	it('deletes a task and brings it back', async () => {
		const { actor } = await k.member('admin');
		const task = await applied<Task>(
			k.runner.invoke('lists.addTask', { title: 'Faturaları öde' }, actor),
		);
		const removed = await applied<{ id: string }>(
			k.runner.invoke('lists.deleteTask', { id: task.id, label: 'Faturaları öde' }, actor),
		);
		expect(await tasks()).toEqual([]);
		await applied(k.runner.invoke('lists.restoreTask', { id: removed.id }, actor));
		expect((await tasks()).map((t) => t.title)).toEqual(['Faturaları öde']);
	});

	it('rolls a repeating chore forward, skipping missed occurrences, and undoes it', async () => {
		const { actor } = await k.member('admin');
		const task = await applied<Task>(
			k.runner.invoke(
				'lists.addTask',
				{
					title: 'Çöpü çıkar',
					dueDate: '2026-09-22',
					recurrence: { freq: 'weekly', byDay: ['TU', 'FR'] },
				},
				actor,
			),
		);
		// Overdue since 22 Sep; completing today (Tue 6 Oct) moves it to Fri 9 Oct, not 25 Sep.
		const next = await applied<Task>(
			k.runner.invoke('lists.completeTask', { id: task.id, dueDate: '2026-09-22' }, actor),
		);
		expect(next).toMatchObject({
			dueDate: '2026-10-09',
			doneAt: null,
			recurrence: { freq: 'weekly', byDay: ['TU', 'FR'] },
		});
		// A repeated tap with the old due date changes nothing.
		const again = await applied<Task>(
			k.runner.invoke('lists.completeTask', { id: task.id, dueDate: '2026-09-22' }, actor),
		);
		expect(again.dueDate).toBe('2026-10-09');
		// Completed early: the next one comes after the due date.
		expect(
			await applied<Task>(
				k.runner.invoke('lists.completeTask', { id: task.id, dueDate: '2026-10-09' }, actor),
			),
		).toMatchObject({
			dueDate: '2026-10-13',
		});
		const undone = await applied<Task>(k.runner.invoke('lists.reopenTask', { id: task.id }, actor));
		expect(undone.dueDate).toBe('2026-10-09');
	});

	it('finishes a series after its last occurrence', async () => {
		const { actor } = await k.member('admin');
		const task = await applied<Task>(
			k.runner.invoke(
				'lists.addTask',
				{
					title: 'İlaç',
					dueDate: '2026-10-06',
					recurrence: { freq: 'daily', until: '2026-10-07' },
				},
				actor,
			),
		);
		await k.runner.invoke('lists.completeTask', { id: task.id }, actor);
		const last = await applied<Task>(k.runner.invoke('lists.completeTask', { id: task.id }, actor));
		expect(last.doneAt).not.toBeNull();
	});

	it('lets supervised members add their own tasks but drafts tasks for others and edits', async () => {
		const { actor: child, member: kid } = await k.member('supervised');
		const { member: parent } = await k.member('admin');
		expect(
			(await k.runner.invoke('lists.addTask', { title: 'Oda topla', assigneeId: kid.id }, child))
				.status,
		).toBe('applied');
		expect(
			(
				await k.runner.invoke(
					'lists.addTask',
					{ title: 'Beni okuldan al', assigneeId: parent.id },
					child,
				)
			).status,
		).toBe('drafted');
		const [own] = await tasks();
		expect((await k.runner.invoke('lists.completeTask', { id: own?.id }, child)).status).toBe(
			'applied',
		);
		expect((await k.runner.invoke('lists.deleteTask', { id: own?.id }, child)).status).toBe(
			'drafted',
		);
		expect(
			(await k.runner.invoke('lists.addTask', { title: 'x' }, { kind: 'ai', source: 'inbox' }))
				.status,
		).toBe('drafted');
	});

	it('validates members and dates', async () => {
		const { actor } = await k.member('admin');
		await expect(
			k.runner.invoke(
				'lists.addTask',
				{ title: 'x', assigneeId: 'member_0192d3c4-0000-7000-8000-000000000000' },
				actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.runner.invoke('lists.addTask', { title: 'x', recurrence: { freq: 'daily' } }, actor),
		).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	it('lists dated tasks first, by date and time', async () => {
		const { actor } = await k.member('admin');
		for (const input of [
			{ title: 'c' },
			{ title: 'b', dueDate: '2026-10-08' },
			{ title: 'a2', dueDate: '2026-10-07', dueTime: '18:00' },
			{ title: 'a1', dueDate: '2026-10-07', dueTime: '09:00' },
		]) {
			await k.runner.invoke('lists.addTask', input, actor);
		}
		expect((await tasks()).map((t) => t.title)).toEqual(['a1', 'a2', 'b', 'c']);
	});
});

describe('shopping', () => {
	it('starts with a default list', async () => {
		expect(await k.route('lists.listShoppingLists').call()).toEqual([
			{ id: DEFAULT_LIST_ID, name: '', openCount: 0 },
		]);
	});

	it('leaves the default list nameless, so each screen shows its own translated default', async () => {
		const [list] = await k.route('lists.listShoppingLists').call();
		expect(list?.name).toBe('');
		// The model is told a neutral name rather than an empty one.
		const { actor } = await k.member('admin');
		await applied(k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Milk' }] }, actor));
		const out = await applied<{ lists: { name: string }[] }>(
			k.runner.invoke('lists.shoppingList', {}, actor),
		);
		expect(out.lists.map((l) => l.name)).toEqual(['Shopping list']);
	});

	it('lets supervised members add and tick items but drafts their removal', async () => {
		const { actor: child } = await k.member('supervised');
		const { actor: parent } = await k.member('member');
		await applied(
			k.runner.invoke(
				'lists.addShoppingItems',
				{ items: [{ title: 'Milk' }, { title: 'Bread' }, { title: 'Eggs' }] },
				child,
			),
		);
		const [milk, bread, eggs] = await items();
		expect(
			(await k.runner.invoke('lists.checkShoppingItem', { id: milk?.id, done: true }, child))
				.status,
		).toBe('applied');
		for (const [id, input] of [
			['lists.deleteShoppingItem', { id: milk?.id }],
			['lists.removeShoppingItems', { ids: [bread?.id] }],
			['lists.clearBought', { listId: DEFAULT_LIST_ID }],
		] as const) {
			expect((await k.runner.invoke(id, input, child)).status).toBe('drafted');
		}
		expect(await items()).toHaveLength(3);
		expect(
			(await k.runner.invoke('lists.deleteShoppingItem', { id: eggs?.id }, parent)).status,
		).toBe('applied');
		expect(await items()).toHaveLength(2);
	});

	it('adds items without duplicates and brings bought items back', async () => {
		const { actor } = await k.member('member');
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Süt', category: 'dairy' }, { title: 'Ekmek' }] },
			actor,
		);
		const milk = (await items()).find((i) => i.title === 'Süt');
		await k.runner.invoke('lists.checkShoppingItem', { id: milk?.id, done: true }, actor);
		// Same product, different case and spacing (Turkish casing): no duplicate, and it is back on the list.
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: '  SÜT ', quantity: '2 L' }] },
			actor,
		);
		const list = await items();
		expect(list).toHaveLength(2);
		expect(list.find((i) => i.id === milk?.id)).toMatchObject({
			doneAt: null,
			quantity: '2 L',
			category: 'dairy',
		});
		expect((await k.route('lists.listShoppingLists').call())[0].openCount).toBe(2);
	});

	it('updates an item on the list by default, and leaves it as it is when asked to keep it', async () => {
		const { actor } = await k.member('admin');
		const add = (input: object) =>
			applied<{ addedIds: string[] }>(k.runner.invoke('lists.addShoppingItems', input, actor));
		await add({ items: [{ title: 'Eggs', quantity: '12', category: 'dairy' }] });

		const kept = await add({
			items: [{ title: 'eggs', quantity: '4', category: 'other' }],
			whenOnList: 'keep',
		});
		expect(kept.addedIds).toEqual([]);
		expect(await items()).toMatchObject([{ title: 'Eggs', quantity: '12', category: 'dairy' }]);

		await add({ items: [{ title: 'eggs', quantity: '4' }], whenOnList: 'update' });
		expect(await items()).toMatchObject([{ title: 'Eggs', quantity: '4' }]);
	});

	it('brings a bought item back with the new quantity even when keeping', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Eggs', quantity: '12' }] },
			actor,
		);
		const eggs = (await items())[0];
		await k.runner.invoke('lists.checkShoppingItem', { id: eggs?.id, done: true }, actor);
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Eggs', quantity: '4' }], whenOnList: 'keep' },
			actor,
		);
		expect(await items()).toMatchObject([{ doneAt: null, quantity: '4' }]);
	});

	it('remembers the category last used for a product', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Domates', category: 'produce' }] },
			actor,
		);
		const [tomato] = await items();
		await k.runner.invoke('lists.deleteShoppingItem', { id: tomato?.id }, actor);
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'domates' }] }, actor);
		expect(await items()).toEqual([
			expect.objectContaining({ title: 'domates', category: 'produce' }),
		]);
	});

	it('orders items by store section, bought last, and clears bought items', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke(
			'lists.addShoppingItems',
			{
				items: [
					{ title: 'Deterjan', category: 'household' },
					{ title: 'Elma', category: 'produce' },
					{ title: 'Peynir', category: 'dairy' },
				],
			},
			actor,
		);
		const apple = (await items()).find((i) => i.title === 'Elma');
		await k.runner.invoke('lists.checkShoppingItem', { id: apple?.id, done: true }, actor);
		expect((await items()).map((i) => i.title)).toEqual(['Peynir', 'Deterjan', 'Elma']);
		expect(
			await applied(k.runner.invoke('lists.clearBought', { listId: DEFAULT_LIST_ID }, actor)),
		).toEqual({ cleared: 1 });
		expect((await items()).map((i) => i.title)).toEqual(['Peynir', 'Deterjan']);
	});

	it('manages lists; supervised members propose list changes and the last list stays', async () => {
		const { actor } = await k.member('admin');
		const { actor: child } = await k.member('supervised');
		const pharmacy = await applied<{ id: string }>(
			k.runner.invoke('lists.createShoppingList', { name: 'Eczane' }, actor),
		);
		expect(
			(await k.runner.invoke('lists.createShoppingList', { name: 'Oyuncak' }, child)).status,
		).toBe('drafted');
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ listId: pharmacy.id, items: [{ title: 'Vitamin' }] },
			child,
		);
		expect(await items(pharmacy.id)).toHaveLength(1);
		await k.runner.invoke(
			'lists.renameShoppingList',
			{ id: DEFAULT_LIST_ID, name: 'Manav' },
			actor,
		);
		await k.runner.invoke('lists.archiveShoppingList', { id: pharmacy.id }, actor);
		expect(await k.route('lists.listShoppingLists').call()).toEqual([
			{ id: DEFAULT_LIST_ID, name: 'Manav', openCount: 0 },
		]);
		await expect(
			k.runner.invoke('lists.archiveShoppingList', { id: DEFAULT_LIST_ID }, actor),
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('exposes addTask and addShoppingItems to the AI pipeline', () => {
		const ids = k.ctx.actions.aiCatalog().map((a) => a.id);
		expect(ids).toEqual(expect.arrayContaining(['lists.addTask', 'lists.addShoppingItems']));
	});
});

describe('duplicate hint', () => {
	it('marks proposed tasks and shopping items that are already there', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke(
			'lists.addTask',
			{ title: 'Pay the trip fee', dueDate: '2026-10-09' },
			actor,
		);
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Süt' }] }, actor);
		const ai = { kind: 'ai', source: 'inbox' } as const;
		await k.runner.invoke(
			'lists.addTask',
			{ title: 'pay the trip fee', dueDate: '2026-10-09' },
			ai,
		);
		await k.runner.invoke(
			'lists.addTask',
			{ title: 'Pay the trip fee', dueDate: '2026-10-10' },
			ai,
		);
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'SÜT' }] }, ai);
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Süt' }, { title: 'Ekmek' }] },
			ai,
		);
		const drafts = await k
			.route('core.listDrafts')
			.call({ query: { status: 'pending', limit: 10 } });
		const hints = drafts.toReversed().map((d: { mayExist: boolean }) => d.mayExist);
		expect(hints).toEqual([true, false, true, false]);
	});
});

describe('taking back a suggested shopping add', () => {
	it('puts merged items back as they were and removes the new ones', async () => {
		const { actor } = await k.member('admin');
		const milk = await applied<{ items: ShoppingItem[] }>(
			k.runner.invoke(
				'lists.addShoppingItems',
				{ items: [{ title: 'Süt', quantity: '1', category: 'dairy' }] },
				actor,
			),
		);
		const milkId = milk.items[0]?.id as string;
		await applied(k.runner.invoke('lists.checkShoppingItem', { id: milkId, done: true }, actor));
		const bought = (await items()).find((i) => i.id === milkId);

		const result = await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'süt', quantity: '6', category: 'other' }, { title: 'Ekmek' }] },
			{ kind: 'ai', source: 'inbox' },
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		await k.runner.approveDraft(result.draftId, actor);
		expect((await items()).find((i) => i.id === milkId)).toMatchObject({
			quantity: '6',
			category: 'other',
			doneAt: null,
		});
		await k.runner.undoDraft(result.draftId, actor);
		const after = await items();
		expect(after.find((i) => i.id === milkId)).toEqual(bought);
		expect(after.map((i) => i.title)).toEqual(['Süt']);
	});

	it('lets only those who manage the list take an add back directly', async () => {
		const { actor } = await k.member('admin');
		const { actor: child } = await k.member('supervised');
		const added = await applied<{ items: ShoppingItem[]; addedIds: string[]; merged: [] }>(
			k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Süt' }] }, actor),
		);
		const input = { addedIds: added.addedIds, merged: [] };
		const proposed = await k.runner.invoke('lists.undoAddShoppingItems', input, child);
		expect(proposed.status).toBe('drafted');
		expect(await items()).toHaveLength(1);
		const done = await k.runner.invoke('lists.undoAddShoppingItems', input, actor);
		expect(done.status).toBe('applied');
		expect(await items()).toHaveLength(0);
	});

	it('flags a draft of which only some items are on the list', async () => {
		const { actor } = await k.member('admin');
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Süt' }] }, actor);
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Süt' }, { title: 'Ekmek' }] },
			{ kind: 'ai', source: 'inbox' },
		);
		const [draft] = await k
			.route('core.listDrafts')
			.call({ query: { status: 'pending', limit: 10 } });
		expect(draft).toMatchObject({ mayExist: false, mayExistSome: true });
	});
});

describe('a suggested task whose due date has passed', () => {
	it('never expires: a late task is still worth doing', async () => {
		const ai = { kind: 'ai', source: 'inbox' } as const;
		const result = await k.runner.invoke(
			'lists.addTask',
			{ title: 'Return the form', dueDate: '2026-10-01' },
			ai,
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		expect(await k.runner.expirePassed()).toBe(0);
		const drafts: { id: string }[] = await k
			.route('core.listDrafts')
			.call({ query: { status: 'pending', limit: 10 } });
		expect(drafts.map((d) => d.id)).toEqual([result.draftId]);
	});
});

describe('shopping list names', () => {
	it('are short and unique, ignoring case and spacing', async () => {
		const { actor } = await k.member('admin');
		const create = (name: string) => k.runner.invoke('lists.createShoppingList', { name }, actor);
		const made = await create('Pharmacy');
		expect(made.status).toBe('applied');
		await expect(create('  pharmacy ')).rejects.toMatchObject({
			code: 'conflict',
			details: { reason: 'name_taken' },
		});
		await expect(create('x'.repeat(31))).rejects.toBeTruthy();
		const other = await create('Hardware');
		const otherId = (other as { output: { id: string } }).output.id;
		await expect(
			k.runner.invoke('lists.renameShoppingList', { id: otherId, name: 'PHARMACY' }, actor),
		).rejects.toMatchObject({ details: { reason: 'name_taken' } });
		// Renaming a list to its own name is fine.
		await k.runner.invoke('lists.renameShoppingList', { id: otherId, name: 'Hardware' }, actor);
	});
});
