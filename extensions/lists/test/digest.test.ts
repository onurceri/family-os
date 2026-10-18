import { type Actor, type DigestOutput, type MemberId, systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskDueDays } from '../src/server/digest.ts';
import lists from '../src/server/index.ts';

// The test clock stands at Thursday 1 January 2026, in UTC.
let k: TestKernel;
let mara: Awaited<ReturnType<TestKernel['member']>>;
let leo: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists], translate: repoTranslate() });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: 'UTC' }, systemActor('test'));
	mara = await k.member('admin');
	leo = await k.member('supervised');
});
afterEach(() => k.close());

const ai = (m = mara, roleId = 'admin'): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: m.member.id as MemberId,
	roleId,
});
const task = (input: Record<string, unknown>) =>
	k.runner.invoke('lists.addTask', input, mara.actor);
const digest = async (id: string, input: Record<string, unknown>, actor: Actor = ai()) => {
	const result = await k.runner.invoke<DigestOutput>(id, input, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};
const titles = (out: DigestOutput) => out.items.map((i) => `${i.date} ${i.title}`);

describe('taskDueDays', () => {
	const once = { rrule: null, rrule_start: null };
	it('counts a task on its due day inside the span', () => {
		expect(
			taskDueDays({ ...once, due_date: '2026-01-05' }, '2026-01-05', '2026-01-11', '2026-01-01'),
		).toEqual(['2026-01-05']);
		expect(
			taskDueDays({ ...once, due_date: '2026-01-12' }, '2026-01-05', '2026-01-11', '2026-01-01'),
		).toEqual([]);
		expect(
			taskDueDays({ ...once, due_date: null }, '2026-01-05', '2026-01-11', '2026-01-01'),
		).toEqual([]);
	});

	it('counts a late task only when the span holds today', () => {
		const late = { ...once, due_date: '2025-12-28' };
		expect(taskDueDays(late, '2026-01-01', '2026-01-07', '2026-01-01')).toEqual(['2025-12-28']);
		expect(taskDueDays(late, '2026-01-05', '2026-01-11', '2026-01-01')).toEqual([]);
	});

	it('lists every date of a repeating task in the span', () => {
		const weekly = {
			due_date: '2026-01-02',
			rrule: 'FREQ=WEEKLY;BYDAY=FR',
			rrule_start: '2026-01-02',
		};
		expect(taskDueDays(weekly, '2026-01-01', '2026-01-17', '2026-01-01')).toEqual([
			'2026-01-02',
			'2026-01-09',
			'2026-01-16',
		]);
		expect(taskDueDays(weekly, '2026-01-10', '2026-01-17', '2026-01-01')).toEqual(['2026-01-16']);
	});
});

describe('lists.tasksDigest', () => {
	it('holds the tasks due in the span with their notes, and what is late today', async () => {
		await task({ title: 'Late fee', dueDate: '2025-12-30' });
		await task({
			title: 'School trip form',
			dueDate: '2026-01-05',
			dueTime: '08:00',
			notes: 'Sign page 2',
		});
		await task({ title: 'Undated' });
		await task({ title: 'Later', dueDate: '2026-01-20' });
		const week = await digest('lists.tasksDigest', { from: '2026-01-01', to: '2026-01-07' });
		// What has no due date is still to do: after the rest, on the span's first day ahead.
		expect(titles(week)).toEqual([
			'2025-12-30 Late fee',
			'2026-01-05 School trip form',
			'2026-01-01 Undated',
		]);
		expect(week.items[0]?.status).toBe('overdue');
		expect(week.items[1]).toMatchObject({ time: '08:00', notes: 'Sign page 2', people: [] });
		expect(week.items[2]?.extra).toEqual({ undated: 'yes' });
		// Next week holds nothing late: what is late is today's.
		const next = await digest('lists.tasksDigest', { from: '2026-01-05', to: '2026-01-11' });
		expect(titles(next)).toEqual(['2026-01-05 School trip form', '2026-01-05 Undated']);
		// A span that is over holds no open task without a date.
		const past = await digest('lists.tasksDigest', { from: '2025-12-01', to: '2025-12-07' });
		expect(titles(past)).toEqual([]);
	});

	it('keeps the tasks of the people asked about and the ones anyone may do', async () => {
		await task({ title: 'Leo packs', dueDate: '2026-01-02', assigneeId: leo.member.id });
		await task({ title: 'Mara pays', dueDate: '2026-01-02', assigneeId: mara.member.id });
		await task({ title: 'Anyone waters', dueDate: '2026-01-02' });
		const out = await digest('lists.tasksDigest', {
			from: '2026-01-02',
			to: '2026-01-02',
			memberIds: [leo.member.id],
		});
		expect(out.items.map((i) => i.title).sort()).toEqual(['Anyone waters', 'Leo packs']);
	});

	it('ranks by the words asked about without leaving a task out', async () => {
		await task({ title: 'Pay the dentist', dueDate: '2026-01-02' });
		await task({ title: 'Pack football kit', dueDate: '2026-01-02' });
		const out = await digest('lists.tasksDigest', {
			from: '2026-01-02',
			to: '2026-01-02',
			about: ['football'],
		});
		expect(out.items.map((i) => i.title)).toEqual(['Pack football kit', 'Pay the dentist']);
	});

	it('says what is due next when the span is empty', async () => {
		await task({ title: 'Renew passport', dueDate: '2026-04-01' });
		const out = await digest('lists.tasksDigest', { from: '2026-01-05', to: '2026-01-11' });
		expect(out.items).toEqual([]);
		expect(out.nextAfter).toMatchObject({ title: 'Renew passport', date: '2026-04-01' });
	});

	it('cuts a crowded span and says so', async () => {
		await task({
			title: 'Feed the fish',
			dueDate: '2026-01-01',
			recurrence: { freq: 'daily', interval: 1 },
		});
		const out = await digest('lists.tasksDigest', { from: '2026-01-01', to: '2026-03-03' });
		expect(out.items).toHaveLength(60);
		expect(out.truncated).toBe(true);
	});

	it('gives nothing to an AI whose area is off', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'lists', access: 'off' },
			mara.actor,
		);
		await expect(
			k.runner.invoke('lists.tasksDigest', { from: '2026-01-01', to: '2026-01-07' }, ai()),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke('lists.shoppingDigest', { from: '2026-01-01', to: '2026-01-07' }, ai()),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('lists.openTasks', () => {
	it('returns the notes of the tasks, and none for a task without', async () => {
		await task({ title: 'School trip form', notes: 'Sign page 2' });
		await task({ title: 'Water the plants' });
		const result = await k.runner.invoke<{ tasks: { title: string; notes?: string }[] }>(
			'lists.openTasks',
			{},
			ai(),
		);
		if (result.status !== 'applied') throw new Error('expected a read');
		expect(result.output.tasks.find((t) => t.title === 'School trip form')?.notes).toBe(
			'Sign page 2',
		);
		expect('notes' in (result.output.tasks.find((t) => t.title === 'Water the plants') ?? {})).toBe(
			false,
		);
	});
});

describe('lists.shoppingDigest', () => {
	it('gives one entry per list that still has things to buy, with how many', async () => {
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Milk' }, { title: 'Bread' }] },
			mara.actor,
		);
		const created = await k.runner.invoke<{ id: string }>(
			'lists.createShoppingList',
			{ name: 'Hardware' },
			mara.actor,
		);
		if (created.status !== 'applied') throw new Error('expected a list');
		const out = await digest('lists.shoppingDigest', {
			from: '2026-01-05',
			to: '2026-01-11',
			memberIds: [leo.member.id],
		});
		expect(out.items).toEqual([
			{
				handle: expect.stringMatching(/^shop_list_/),
				kind: 'shopping_list',
				title: 'Groceries',
				date: '2026-01-05',
				people: [],
				extra: { open: '2', things: 'Milk, Bread' },
				href: '/lists/shopping',
			},
		]);
	});

	it('ranks the list that has the thing asked about first', async () => {
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Milk' }] }, mara.actor);
		const created = await k.runner.invoke<{ id: string }>(
			'lists.createShoppingList',
			{ name: 'Hardware' },
			mara.actor,
		);
		if (created.status !== 'applied') throw new Error('expected a list');
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ listId: created.output.id, items: [{ title: 'Screws' }] },
			mara.actor,
		);
		const out = await digest('lists.shoppingDigest', {
			from: '2026-01-01',
			to: '2026-01-01',
			about: ['screws'],
		});
		expect(out.items.map((i) => i.title)).toEqual(['Hardware', 'Groceries']);
	});
});

describe('lists digests links', () => {
	it('opens a task by its id and the shopping page for a list', async () => {
		const made = await task({ title: 'School trip form', dueDate: '2026-01-05' });
		if (made.status !== 'applied') throw new Error('expected a task');
		const tasks = await digest('lists.tasksDigest', { from: '2026-01-05', to: '2026-01-11' });
		expect(tasks.items[0]?.href).toBe(`/lists/tasks?task=${(made.output as { id: string }).id}`);
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Milk' }] }, mara.actor);
		const shopping = await digest('lists.shoppingDigest', { from: '2026-01-05', to: '2026-01-11' });
		expect(shopping.items[0]?.href).toBe('/lists/shopping');
	});
});
