import type { Mention, MentionKindDefinition, Resolution } from '@famos/sdk';
import {
	createTestClock,
	createTestKernel,
	resolveMentions,
	SHARE_AI,
	type TestKernel,
} from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';

// Tuesday 6 October 2026, 10:00 in the family time zone (UTC).
const TODAY = Date.UTC(2026, 9, 6, 10, 0);

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists], clock: createTestClock(TODAY) });
	admin = await k.member('admin', 'Mara');
});
afterEach(() => k.close());

const kinds = lists.ai?.kinds ?? [];

async function run<T>(actionId: string, input: unknown): Promise<T> {
	const result = await k.runner.invoke(actionId, input, admin.actor);
	if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
	return result.output as T;
}

async function addItems(items: { title: string; quantity?: string }[], listId?: string) {
	return run<{ items: { id: string; title: string }[] }>('lists.addShoppingItems', {
		items,
		...(listId && { listId }),
	});
}

async function addTask(input: Record<string, unknown>) {
	return run<{ id: string }>('lists.addTask', input);
}

const resolve = (
	kind: string,
	mentions: Omit<Mention, 'kind'>[],
	env: { text?: string | null; sharer?: string | null } = {},
) =>
	resolveMentions(
		k,
		kind,
		mentions.map((m) => ({ ...m, kind })),
		{ text: null, sharer: null, ...env },
	);

/** Drafts what a resolution proposes, the way the AI pipeline would, and returns the status. */
async function draft(resolution: Resolution | undefined) {
	if (!resolution || !('propose' in resolution)) throw new Error('expected a suggestion');
	const { actionId, input, uncertain } = resolution.propose;
	const result = await k.ctx.actions.invoke(actionId, input, SHARE_AI, {
		draft: { uncertainFields: [...(uncertain ?? [])] },
	});
	return result.status;
}

describe('the lists kinds', () => {
	it('are offered to the AI, and their examples name only their own slots', () => {
		expect(
			k.ctx.actions
				.aiKinds()
				.map((kind) => kind.id)
				.toSorted(),
		).toEqual(['lists.bought', 'lists.shoppingItem', 'lists.task', 'lists.taskDone']);
		for (const kind of kinds as readonly MentionKindDefinition[])
			expect(kind.examples.length).toBeGreaterThan(0);
	});
});

describe('lists.shoppingItem', () => {
	it('puts every product of a message on the list in one suggestion, with amounts and sections', async () => {
		const out = await resolve(
			'lists.shoppingItem',
			[
				{ title: 'Milk', quantity: '2 litres', variant: 'dairy' },
				{ title: 'Eggs', quantity: 'a dozen' },
				{ title: 'Bananas', variant: 'produce' },
			],
			{ text: 'grab 2 litres of milk, a dozen eggs and bananas' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.addShoppingItems',
					input: {
						items: [
							{ title: 'Milk', quantity: '2 litres', category: 'dairy' },
							{ title: 'Eggs', quantity: 'a dozen' },
							{ title: 'Bananas', category: 'produce' },
						],
					},
					subject: 'Milk, Eggs, Bananas',
					from: [0, 1, 2],
				},
			},
		]);
		expect(await draft(out[0])).toBe('drafted');
	});

	it('replays "ice cream and a new football": what is on the list is left out, "new" is no amount', async () => {
		await addItems([{ title: 'Ice cream' }]);
		const out = await resolve(
			'lists.shoppingItem',
			[{ title: 'ice cream' }, { title: 'Football', quantity: 'new' }],
			{ text: 'ice cream and a new football pls' },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'ice cream', from: [0] } },
			{
				propose: {
					actionId: 'lists.addShoppingItems',
					input: { items: [{ title: 'Football' }] },
					subject: 'Football',
					uncertain: ['items.0.quantity'],
					from: [1],
				},
			},
		]);
		expect(await draft(out[1])).toBe('drafted');
	});

	it('keeps a real amount written as words, and takes an amount out of a title', async () => {
		const out = await resolve('lists.shoppingItem', [
			{ title: 'Eggs', quantity: 'half a dozen' },
			{ title: '2 kg Tomatoes' },
		]);
		const [only] = out;
		expect(only && 'propose' in only && only.propose.input).toEqual({
			items: [
				{ title: 'Eggs', quantity: 'half a dozen' },
				{ title: 'Tomatoes', quantity: '2 kg' },
			],
		});
	});

	it('starts what is left after an amount with a capital, and keeps a title typed without one', async () => {
		const out = await resolve('lists.shoppingItem', [
			{ title: '2 L oat milk' },
			{ title: 'sourdough bread' },
		]);
		const [only] = out;
		expect(only && 'propose' in only && only.propose.input).toEqual({
			items: [{ title: 'Oat milk', quantity: '2 L' }, { title: 'sourdough bread' }],
		});
	});

	it('is one line for a product named twice, and goes on the list the message names', async () => {
		const hardware = await run<{ id: string }>('lists.createShoppingList', {
			name: 'Hardware store',
		});
		const out = await resolve(
			'lists.shoppingItem',
			[
				{ title: 'Picture hooks', place: 'Hardware store' },
				{ title: 'Milk' },
				{ title: 'picture hooks', quantity: '10', place: 'the Hardware store list' },
			],
			{ text: 'picture hooks for the Hardware store list, and milk; 10 picture hooks' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.addShoppingItems',
					input: { listId: hardware.id, items: [{ title: 'Picture hooks', quantity: '10' }] },
					subject: 'Picture hooks',
					from: [0, 2],
				},
			},
			{
				propose: {
					actionId: 'lists.addShoppingItems',
					input: { items: [{ title: 'Milk' }] },
					subject: 'Milk',
					from: [1],
				},
			},
		]);
	});

	it('adds back what was bought, and refuses a mention without a product', async () => {
		const { items } = await addItems([{ title: 'Bread' }]);
		await run('lists.checkShoppingItem', { id: items[0]?.id, done: true });
		const out = await resolve('lists.shoppingItem', [{ title: 'Bread' }, { quantity: '2' }]);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.addShoppingItems',
					input: { items: [{ title: 'Bread' }] },
					subject: 'Bread',
					from: [0],
				},
			},
			{ refuse: { reason: 'incomplete', subject: null, from: [1] } },
		]);
	});

	it('marks the fields the model was unsure of', async () => {
		const out = await resolve('lists.shoppingItem', [
			{ title: 'Cheese', variant: 'dairy', quantity: '200 g', unsure: ['quantity', 'variant'] },
		]);
		const [only] = out;
		expect(only && 'propose' in only && only.propose.uncertain).toEqual([
			'items.0.quantity',
			'items.0.category',
		]);
	});
});

describe('lists.bought', () => {
	it('ticks off the item the message names, on the list it names', async () => {
		const hardware = await run<{ id: string }>('lists.createShoppingList', {
			name: 'Hardware store',
		});
		const { items } = await addItems(
			[{ title: 'E27 light bulbs' }, { title: 'Picture wire' }],
			hardware.id,
		);
		await addItems([{ title: 'Milk' }]);
		const text = 'Got the E27 light bulbs already, tick them off the Hardware store list';
		const out = await resolve(
			'lists.bought',
			[{ target: 'E27 light bulbs', place: 'Hardware store' }],
			{ text },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.checkShoppingItem',
					input: { id: items[0]?.id, done: true, label: 'E27 light bulbs' },
					subject: 'E27 light bulbs',
					targetTitle: 'E27 light bulbs',
					from: [0],
				},
			},
		]);
		expect(await draft(out[0])).toBe('drafted');
	});

	it('finds nothing to tick when the item is not listed, and says when it is ticked already', async () => {
		const { items } = await addItems([{ title: 'Picture wire' }, { title: 'Bread' }]);
		await run('lists.checkShoppingItem', { id: items[1]?.id, done: true });
		const out = await resolve('lists.bought', [
			{ target: 'E27 light bulbs' },
			{ target: 'the bread' },
			{},
		]);
		expect(out).toEqual([
			{ refuse: { reason: 'unknown', subject: 'E27 light bulbs', from: [0] } },
			{ refuse: { reason: 'already', subject: 'the bread', from: [1] } },
			{ refuse: { reason: 'incomplete', subject: null, from: [2] } },
		]);
	});

	it('does not tick a near item the message does not name', async () => {
		await addItems([{ title: 'Picture hooks' }, { title: 'Picture wire' }]);
		const out = await resolve('lists.bought', [{ target: 'picture' }], {
			text: 'got the picture stuff',
		});
		expect(out).toEqual([
			{
				refuse: {
					reason: 'ambiguous',
					subject: 'picture (Picture hooks, Picture wire)',
					from: [0],
				},
			},
		]);
	});

	it('ticks an item once when the message names it twice', async () => {
		const { items } = await addItems([{ title: 'Milk' }]);
		const out = await resolve('lists.bought', [{ target: 'milk' }, { target: 'the milk' }]);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.checkShoppingItem',
					input: { id: items[0]?.id, done: true, label: 'milk' },
					subject: 'milk',
					targetTitle: 'Milk',
					from: [0, 1],
				},
			},
		]);
	});
});

describe('lists.task', () => {
	it('reads the deadline, the time and the person the message names', async () => {
		const sam = await k.member('member', 'Sam');
		const out = await resolve(
			'lists.task',
			[
				{
					title: 'Call the plumber',
					people: ['Sam'],
					date: { text: 'tomorrow', inDays: 1 },
					time: '09:00',
					timeText: '9:00',
				},
			],
			{ text: 'Sam, can you call the plumber tomorrow by 9:00?', sharer: admin.member.id },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.addTask',
					input: {
						title: 'Call the plumber',
						assigneeId: sam.member.id,
						dueDate: '2026-10-07',
						dueTime: '09:00',
					},
					subject: 'Call the plumber',
					from: [0],
				},
			},
		]);
		expect(await draft(out[0])).toBe('drafted');
	});

	it('replays a task nobody is named for: the sharer alone is marked for a look', async () => {
		await k.member('member', 'Tom');
		const text =
			'Swim club: the autumn term fee of 120 is due by Friday 16 October. Please pay at the front desk.';
		const out = await resolve(
			'lists.task',
			[
				{
					title: 'Pay the swim club term fee',
					forMe: true,
					date: { text: 'Friday 16 October', day: 16, month: 10, weekday: 5 },
					notes: 'Fee: 120, at the front desk',
				},
			],
			{ text, sharer: admin.member.id },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.addTask',
					input: {
						title: 'Pay the swim club term fee',
						assigneeId: admin.member.id,
						dueDate: '2026-10-16',
						notes: 'Fee: 120, at the front desk',
					},
					subject: 'Pay the swim club term fee',
					uncertain: ['assigneeId'],
					from: [0],
				},
			},
		]);
		// The same mention naming the sharer by a name the message does not write.
		const named = await resolve('lists.task', [{ title: 'Pay the fee', people: ['Mara'] }], {
			text,
			sharer: admin.member.id,
		});
		expect(named[0] && 'propose' in named[0] && named[0].propose.uncertain).toEqual(['assigneeId']);
	});

	it('reads "before the end of the month" as its last day, marked for a look', async () => {
		const out = await resolve('lists.task', [
			{
				title: 'Renew the car insurance',
				date: { text: 'before the end of the month', month: 10, approximate: true },
			},
		]);
		expect(out[0] && 'propose' in out[0] && out[0].propose).toMatchObject({
			input: { title: 'Renew the car insurance', dueDate: '2026-10-31' },
			uncertain: ['dueDate'],
		});
	});

	// Found in use: "Practise every day this week pls!" got the last day of the month.
	it('reads "this week" as the last day of the week, marked for a look', async () => {
		for (const approximate of [true, undefined]) {
			const out = await resolve('lists.task', [
				{
					title: 'Practise piano every day',
					date: { text: 'this week', week: 'this', ...(approximate && { approximate }) },
				},
			]);
			expect(out[0] && 'propose' in out[0] && out[0].propose).toMatchObject({
				input: { title: 'Practise piano every day', dueDate: '2026-10-11' },
				uncertain: ['dueDate'],
			});
		}
	});

	it('keeps a deadline day the words do not write in digits, marked for a look', async () => {
		const out = await resolve('lists.task', [
			{
				title: 'Return the form',
				date: { text: 'by the twentieth of October', day: 20, month: 10 },
			},
			{ title: 'Pay the fee', date: { text: 'by 20 October', day: 20, month: 10 } },
		]);
		expect(out[0] && 'propose' in out[0] && out[0].propose).toMatchObject({
			input: { dueDate: '2026-10-20' },
			uncertain: ['dueDate'],
		});
		expect(out[1] && 'propose' in out[1] && out[1].propose.uncertain).toBeUndefined();
	});

	it('doubts a deadline that names a weekday its date does not fall on', async () => {
		// 9 October 2026 is a Friday; the notice says Thursday.
		const out = await resolve(
			'lists.task',
			[{ title: 'Pay the trip fee', date: { text: '9 October, Thursday', day: 9, month: 10 } }],
			{ text: 'Pay the trip fee by 9 October, Thursday' },
		);
		expect(out[0] && 'propose' in out[0] && out[0].propose).toMatchObject({
			input: { dueDate: '2026-10-09' },
			uncertain: ['dueDate'],
		});
	});

	it('leaves out a task already on the list for the same deadline, and one named twice', async () => {
		await addTask({ title: 'Pay the trip fee', dueDate: '2026-10-23' });
		const out = await resolve('lists.task', [
			{ title: 'pay the trip fee', date: { text: '23 October', day: 23, month: 10 } },
			{ title: 'Sign the form' },
			{ title: 'Sign the form' },
			{ notes: 'nothing to do' },
		]);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'pay the trip fee', from: [0] } },
			{
				propose: {
					actionId: 'lists.addTask',
					input: { title: 'Sign the form' },
					subject: 'Sign the form',
					from: [1, 2],
				},
			},
			{ refuse: { reason: 'incomplete', subject: null, from: [3] } },
		]);
	});

	it('gives a weekly chore its first day and an end read from its words', async () => {
		const out = await resolve('lists.task', [
			{
				title: 'Take out the recycling',
				repeat: {
					every: 'week',
					weekdays: [4],
					until: { text: 'until the end of November', month: 11 },
				},
			},
		]);
		expect(out[0] && 'propose' in out[0] && out[0].propose.input).toEqual({
			title: 'Take out the recycling',
			dueDate: '2026-10-08',
			recurrence: { freq: 'weekly', interval: 1, byDay: ['TH'], until: '2026-11-30' },
		});
		expect(await draft(out[0])).toBe('drafted');
	});

	it('leaves a task for several people unassigned, for a person to give', async () => {
		await k.member('member', 'Sam');
		const out = await resolve(
			'lists.task',
			[{ title: 'Tidy the garage', people: ['Mara', 'Sam'] }],
			{
				text: 'Mara and Sam, tidy the garage',
			},
		);
		expect(out[0] && 'propose' in out[0] && out[0].propose).toMatchObject({
			input: { title: 'Tidy the garage' },
			uncertain: ['assigneeId'],
		});
	});
});

describe('lists.taskDone', () => {
	it('replays "I paid the swim course fee": the listed task is completed', async () => {
		const fee = await addTask({ title: 'Pay the swim course fee', dueDate: '2026-10-09' });
		await addTask({ title: 'Book the dentist' });
		const out = await resolve('lists.taskDone', [{ target: 'swim course fee' }], {
			text: 'I paid the swim course fee this morning.',
		});
		expect(out).toEqual([
			{
				propose: {
					actionId: 'lists.completeTask',
					input: { id: fee.id, label: 'swim course fee', dueDate: '2026-10-09' },
					subject: 'swim course fee',
					targetTitle: 'Pay the swim course fee',
					from: [0],
				},
			},
		]);
		expect(await draft(out[0])).toBe('drafted');
	});

	it('says a done task is done already, and an unlisted one unknown', async () => {
		const form = await addTask({ title: 'Return the permission slip' });
		await run('lists.completeTask', { id: form.id });
		const out = await resolve('lists.taskDone', [
			{ target: 'permission slip' },
			{ target: 'the car wash' },
		]);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'permission slip', from: [0] } },
			{ refuse: { reason: 'unknown', subject: 'the car wash', from: [1] } },
		]);
	});
});
