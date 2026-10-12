import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Asker;
let can: Asker;
let kid: Asker;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'en' },
		systemActor('test'),
	);
	ayse = await k.member('admin', 'Ayşe');
	can = await k.member('member', 'Can');
	kid = await k.member('supervised', 'Elif');
});
afterEach(() => k.close());

async function ask(who: Asker, text: string, threadId?: string) {
	const result = await k.runner.invoke<{ threadId: string }>(
		'assistant.sendMessage',
		{ text, ...(threadId && { threadId }) },
		who.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	return result.output;
}

const drafts = () =>
	k.ctx.db
		.withTables<{ core_drafts: { id: string; action_id: string; input: string; status: string } }>()
		.selectFrom('core_drafts')
		.selectAll()
		.execute();

async function createEvent(input: Record<string, unknown>) {
	const made = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, ayse.actor);
	if (made.status !== 'applied') throw new Error('expected applied');
	return made.output.id;
}

describe('an assistant turn never acts on the closest thing', () => {
	it('refuses "Move the Delft board meeting" sent to "Delft project call" with no label', async () => {
		await createEvent({ title: 'Delft project call', date: '2026-01-20', startTime: '10:00' });
		k.llm.respondChat([
			// The search has no dates: it looks from today on.
			{ tool: 'calendar_findEvents', input: { text: 'delft' } },
			// Real model output: the closest event, with no label.
			{ tool: 'calendar_changeEvent', input: { id: 'cal_event:1', startTime: '11:00' } },
			{
				tool: 'calendar_changeEvent',
				input: { id: 'cal_event:1', startTime: '11:00', label: 'Delft board meeting' },
			},
			{ text: 'There is no Delft board meeting on the calendar.' },
		]);
		await ask(ayse, 'Move the Delft board meeting to 11:00');
		const [found, unlabelled, wrong] = k.llm.chatTrace;
		expect(found?.result).toContain('Delft project call');
		expect(unlabelled?.result).toContain('Say which one you mean');
		expect(wrong?.result).toContain(
			"That is 'Delft project call', not 'Delft board meeting'. If it is not on the list, tell the person.",
		);
		expect(await drafts()).toEqual([]);
	});

	it('refuses a second suggestion on the same item under other words', async () => {
		// "Tick off the milk and the oat milk": both suggestions went to the Oat milk row.
		const add = (title: string) =>
			k.runner.invoke('lists.addShoppingItems', { items: [{ title }] }, ayse.actor);
		await add('Oat milk');
		k.clock.advance(1000);
		await add('Milk');
		const items = await k.route('lists.listShoppingItems').call({
			params: { listId: (await k.route('lists.listShoppingLists').call())[0].id },
		});
		const milk = items.find((i: { title: string }) => i.title === 'Milk');
		await k.runner.invoke('lists.checkShoppingItem', { id: milk.id, done: true }, ayse.actor);
		k.llm.respondChat([
			{ tool: 'lists_shoppingList', input: {} },
			{ tool: 'lists_checkShoppingItem', input: { id: 'shop_item:1', done: true, label: 'Milk' } },
			{
				tool: 'lists_checkShoppingItem',
				input: { id: 'shop_item:1', done: true, label: 'Oat milk' },
			},
			{ text: 'Done.' },
		]);
		await ask(ayse, 'Tick off the milk and the oat milk');
		const [list, first, second] = k.llm.chatTrace;
		// The bought Milk is on the list, marked as bought.
		expect(list?.result).toContain('"title":"Milk"');
		expect(list?.result).toContain('"bought":true');
		expect(first?.result).toContain('"status":"drafted"');
		expect(second?.result).toContain("already suggested in this turn for 'milk'");
		expect(await drafts()).toHaveLength(1);
		// The draft carries what will really be ticked off.
		expect(JSON.parse((await drafts())[0]?.input ?? '{}')).toMatchObject({ label: 'Oat milk' });
	});
});

describe('a follow-up in the same thread', () => {
	const sundayKey = String(epochOf('2026-01-11', '20:00', TZ));

	async function weeklyPlanning() {
		await createEvent({
			title: 'Sunday planning',
			date: '2026-01-04',
			startTime: '20:00',
			recurrence: { freq: 'weekly', byDay: ['SU'] },
		});
	}

	it('moves the date it just looked up instead of adding a second event', async () => {
		await weeklyPlanning();
		k.llm.respondChat([
			{ tool: 'calendar_findEvents', input: { text: 'planning' } },
			{ text: 'Sunday planning is at 20:00. Shall I move it?' },
		]);
		const sent = await ask(ayse, 'Move Sunday planning to 18:00');

		k.llm.respondChat([
			// Real model output of the follow-up: it still knows the handle of the first turn.
			{
				tool: 'calendar_changeEvent',
				input: {
					id: 'cal_event:1',
					occurrence: sundayKey,
					startTime: '18:00',
					label: 'Sunday planning',
				},
			},
			{ text: 'I suggested moving it.' },
		]);
		await ask(ayse, 'Yes, move it to 18:00.', sent.threadId);

		const call = k.llm.chatCalls.at(-1);
		expect(call?.tools.map((t) => t.name)).toContain('calendar_changeEvent');
		expect(call?.system).toContain('- cal_event:1: Sunday planning');
		expect(k.llm.chatTrace.at(-1)?.result).toContain('"status":"drafted"');
		const made = await drafts();
		expect(made.map((d) => d.action_id)).toEqual(['calendar.changeEvent']);
		expect(JSON.parse(made[0]?.input ?? '{}')).toMatchObject({
			occurrence: sundayKey,
			label: 'Sunday planning',
		});

		// Approving it moves that Sunday and leaves the series.
		await k.runner.approveDraft(made[0]?.id as string, ayse.actor);
		const week = await k
			.route('calendar.listOccurrences')
			.call({ query: { from: '2026-01-11', to: '2026-01-11' } });
		expect(week).toMatchObject([{ start: epochOf('2026-01-11', '18:00', TZ), recurring: false }]);
	});

	it('does not accept a handle the thread never showed', async () => {
		await weeklyPlanning();
		k.llm.respondChat([
			{ tool: 'calendar_changeEvent', input: { id: 'cal_event:1', startTime: '18:00' } },
			{ text: 'I could not.' },
		]);
		await ask(ayse, 'Move it to 18:00');
		expect(k.llm.chatTrace.at(-1)?.result).toContain('Error:');
		expect(await drafts()).toEqual([]);
	});

	it('keeps the handles of a thread private to that thread', async () => {
		await weeklyPlanning();
		k.llm.respondChat([
			{ tool: 'calendar_findEvents', input: { text: 'planning' } },
			{ text: 'It is at 20:00.' },
		]);
		await ask(ayse, 'When is Sunday planning?');
		k.llm.respondChat([{ text: 'Hello.' }]);
		await ask(ayse, 'Hi');
		expect(k.llm.chatCalls.at(-1)?.system).not.toContain('cal_event:1');
	});
});

describe('what the assistant says about a suggestion', () => {
	const addMilk = [
		{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
		{ text: 'Done.' },
	];

	it('says it will be added automatically when auto-approval is on for the person', async () => {
		await k.runner.invoke(
			'core.setAutoApproval',
			{
				actionId: 'lists.addShoppingItems',
				setting: { proposerCapability: 'lists.shopping.edit' },
			},
			ayse.actor,
		);
		k.llm.respondChat(addMilk);
		await ask(can, 'Add milk to the shopping list');
		const result = k.llm.chatTrace.at(-1)?.result ?? '';
		expect(result).toContain('It will be added automatically in a moment');
		expect(result).not.toContain('not added yet');
	});

	it('says a person approves it when auto-approval is off', async () => {
		k.llm.respondChat(addMilk);
		await ask(can, 'Add milk to the shopping list');
		const result = k.llm.chatTrace.at(-1)?.result ?? '';
		expect(result).toContain('Suggested, not added yet');
		expect(result).not.toContain('automatically');
		expect(result).not.toContain('cannot approve it themselves');
	});

	it('says someone else approves it when the asker cannot', async () => {
		k.llm.respondChat(addMilk);
		await ask(kid, 'Add milk to the shopping list');
		expect(k.llm.chatTrace.at(-1)?.result).toContain(
			'another person in the household who may approve it',
		);
	});
});
