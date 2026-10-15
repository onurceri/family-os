import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import vehicles from '@famos/ext-vehicles/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';
import { toolName } from '../src/server/tools.ts';

const TZ = 'Europe/Istanbul';
type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Asker;

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, records, vehicles, assistant],
		translate: repoTranslate(),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'en' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-12', '09:00', TZ)); // a Monday
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

const resultOf = (tool: string) => {
	const step = k.llm.chatTrace.find((t) => t.tool === tool);
	return step?.result ?? '';
};

describe('the tools offered to the model', () => {
	const asAssistant = () =>
		({
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: ayse.member.id as never,
			roleId: 'admin',
		}) as const;

	it('are all of them, so a change is never cut for want of an area word', async () => {
		const every = [
			...k.ctx.actions.aiReadTools({ local: false, actor: asAssistant() }),
			...k.ctx.actions.aiCatalog({ local: false, actor: asAssistant() }),
		].map((info) => toolName(info.id));
		for (const question of [
			'Move the swimming on Tuesday 20 October to 18:00',
			'Tick off the bananas',
		]) {
			k.llm.respondChat([{ text: 'Ok.' }]);
			await ask(question);
			const offered = k.llm.chatCalls.at(-1)?.tools.map((t) => t.name) ?? [];
			expect(offered.toSorted()).toEqual(every.toSorted());
			expect(offered).toContain('calendar_changeEvent');
			expect(offered).toContain('calendar_deleteEvent');
			expect(offered).toContain('lists_checkShoppingItem');
		}
	});

	it('come with a rule against claiming a suggestion no tool made', async () => {
		k.llm.respondChat([{ text: 'Ok.' }]);
		await ask('Move the swimming');
		expect(k.llm.chatCalls[0]?.system).toContain('only when a tool returned status "drafted"');
	});
});

describe('one date of a timed repeating event', () => {
	it('is moved when the model names the day, and the card applies', async () => {
		// Real model output: the date of the occurrence, not its key.
		const id = await createEvent({
			title: "Ellie's piano",
			date: '2026-10-08',
			startTime: '16:00',
			endTime: '16:45',
			recurrence: { freq: 'weekly', byDay: ['TH'] },
		});
		k.llm.respondChat([
			{ tool: 'calendar_findEvents', input: { text: 'piano' } },
			{
				tool: 'calendar_changeEvent',
				input: { id: 'cal_event:1', occurrence: '2026-10-15', startTime: '17:00', label: 'piano' },
			},
			{
				tool: 'calendar_changeEvent',
				input: { id: 'cal_event:1', occurrence: '2026-10-14', startTime: '17:00', label: 'piano' },
			},
			{ text: 'Suggested.' },
		]);
		await ask("Move Ellie's piano on 15 October to 17:00");
		const [, good, bad] = k.llm.chatTrace;
		expect(good?.result).toContain('"status":"drafted"');
		// A day the series does not have is refused to the model, so no card could fail later.
		expect(bad?.result).toContain('does not happen on 2026-10-14');
		const pending = await drafts();
		expect(pending).toHaveLength(1);
		const [draft] = pending;
		expect(JSON.parse(draft?.input ?? '{}').occurrence).toBe(
			String(epochOf('2026-10-15', '16:00', TZ)),
		);
		await k.runner.approveDraft(draft?.id as never, ayse.actor);
		const moved = await k.route('calendar.listOccurrences').call({
			query: { from: '2026-10-15', to: '2026-10-15' },
			actor: ayse.actor,
		});
		expect(moved).toMatchObject([{ start: epochOf('2026-10-15', '17:00', TZ) }]);
		expect(id).toBeTruthy();
	});
});

describe('finding events', () => {
	it('names the next match with its handle when a person filter hid the Tuesday swims', async () => {
		// Real model output for Lukas: the filter to Lukas hid what Noah and Ellie swim.
		const lukas = await k.member('member', 'Lukas');
		const noah = await k.member('member', 'Noah');
		await createEvent({
			title: 'Swimming',
			date: '2026-10-13',
			startTime: '17:00',
			memberIds: [noah.member.id],
		});
		await createEvent({
			title: 'Swimming gala',
			date: '2026-11-07',
			startTime: '10:00',
			memberIds: [lukas.member.id],
		});
		k.llm.respondChat([
			{
				tool: 'calendar_findEvents',
				input: { text: 'swimming', from: '2026-10-13', to: '2026-10-13', members: ['member:2'] },
			},
			{ text: 'Swimming is on Tuesday.' },
		]);
		await ask('When is swimming on Tuesday?');
		const result = resultOf('calendar_findEvents');
		expect(result).toContain('"events":[]');
		expect(result).toMatch(/"nextMatch":\{"id":"cal_event:\d+"/);
		expect(k.llm.chatCalls[0]?.system).toContain(
			'Never filter by person when the person names an activity',
		);
	});

	it('takes `from` alone as one day, and names what it got when it cannot search', async () => {
		await createEvent({ title: 'Swim', date: '2026-10-13', startTime: '17:00' });
		k.llm.respondChat([
			{ tool: 'calendar_findEvents', input: { from: '2026-10-13' } },
			{ tool: 'calendar_findEvents', input: { to: '2026-10-13' } },
			{ text: 'Ok.' },
		]);
		await ask('What is on Tuesday?');
		const [one, none] = k.llm.chatTrace;
		expect(one?.result).toContain('"title":"Swim"');
		expect(none?.result).toContain('Received: to');
	});
});

describe('what the model reads after a suggestion', () => {
	it('is a sentence built from the card title and its subject', async () => {
		k.llm.respondChat([
			{
				tool: 'lists_addTask',
				input: { title: 'Pay the swim club fee', dueDate: '2026-10-20' },
			},
			{ text: 'Suggested.' },
		]);
		await ask('Add a task to pay the swim club fee by 20 October');
		const say = JSON.parse(
			resultOf('lists_addTask')
				.replace(/^<tool_result[^>]*>\n/, '')
				.replace(/\n<\/tool_result>$/, ''),
		).say as string;
		expect(say).toBe(
			'Suggested, not added yet: Add a task: Pay the swim club fee. It appears once someone in the household approves it.',
		);
		expect(say).not.toContain('Adds a to-do');
	});

	it('warns that it may already be there, matching the title by its words', async () => {
		await k.runner.invoke(
			'lists.addTask',
			{ title: 'Buy a birthday present for Mila', dueDate: '2026-10-20' },
			ayse.actor,
		);
		k.llm.respondChat([
			{ tool: 'lists_addTask', input: { title: 'Buy a present for Mila' } },
			{ text: 'It may be there already.' },
		]);
		await ask('Remind me to buy a present for Mila');
		const result = resultOf('lists_addTask');
		expect(result).toContain('"mayExist":true');
		expect(result).toContain('It may already be there');
	});

	it('names the event already there that the person can move instead, and moves nothing', async () => {
		await createEvent({ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00' });
		k.llm.respondChat([
			{
				tool: 'calendar_createEvent',
				input: { title: 'Regional gala', date: '2026-11-14', startTime: '09:00' },
			},
			{ text: 'Suggested.' },
		]);
		await ask('The regional gala moved to Sat 14 Nov 09:00');
		const say = JSON.parse(
			resultOf('calendar_createEvent')
				.replace(/^<tool_result[^>]*>\n/, '')
				.replace(/\n<\/tool_result>$/, ''),
		).say as string;
		expect(say).toContain(
			'Already there: Regional Gala, 2026-11-07 18:00. You can move that one to 2026-11-14 09:00 instead when you decide.',
		);
		expect(say).not.toContain('It may already be there');
		// The suggestion stays what the model proposed: only the person turns it into a move.
		expect((await drafts()).map((d) => [d.action_id, d.status])).toEqual([
			['calendar.createEvent', 'pending'],
		]);
	});
});

describe('finding one item in a long shopping list', () => {
	it('is done with text, and a list cut at the budget says so', async () => {
		for (const batch of [0, 1, 2]) {
			await k.runner.invoke(
				'lists.addShoppingItems',
				{
					items: Array.from({ length: 40 }, (_, i) => ({
						title: `Item number ${batch * 40 + i + 1}`,
					})),
				},
				ayse.actor,
			);
			k.clock.advance(1000);
		}
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Cheddar' }] }, ayse.actor);
		k.llm.respondChat([
			{ tool: 'lists_shoppingList', input: {} },
			{ tool: 'lists_shoppingList', input: { text: 'cheddar cheese' } },
			{ text: 'Ok.' },
		]);
		await ask('Is there cheddar on the list?');
		const [all, found] = k.llm.chatTrace;
		expect(all?.result).toContain('"truncated":true');
		expect(all?.result).not.toContain('Cheddar');
		expect(found?.result).toContain('"title":"Cheddar"');
		expect(found?.result).not.toContain('truncated');
		expect(found?.result).not.toContain('Item number');
	});
});

describe('suggestion labels', () => {
	it('name each suggestion by its action and subject, not by the group', async () => {
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Milk' }] }, ayse.actor);
		const list = await k.route('lists.listShoppingLists').call({ actor: ayse.actor });
		const items = await k.route('lists.listShoppingItems').call({
			params: { listId: list[0].id },
			actor: ayse.actor,
		});
		const ai = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: ayse.member.id as never,
			roleId: 'admin',
		} as const;
		const draft = await k.runner.invoke(
			'lists.checkShoppingItem',
			{ id: items[0].id, done: true, label: 'Milk' },
			ai,
			{ draft: { sourceKind: 'inbox', sourceId: 'x', summary: 'Quick add: groceries' } },
		);
		if (draft.status !== 'drafted') throw new Error('expected a draft');
		const read = async () => {
			const result = await k.runner.invoke<{
				suggestions: { label: string; group?: string }[];
			}>('core.mySuggestions', { limit: 5 }, ai);
			if (result.status !== 'applied') throw new Error('expected a read');
			return result.output.suggestions;
		};
		expect(await read()).toMatchObject([
			{ label: 'Tick off (or untick) a shopping item: Milk', group: 'Quick add: groceries' },
		]);

		// A draft stored before they carried the real title: the action says what it is called.
		const input = JSON.stringify({ id: items[0].id, done: true });
		await k.ctx.db
			.withTables<{ core_drafts: { input: string; id: string } }>()
			.updateTable('core_drafts')
			.set({ input })
			.where('id', '=', draft.draftId)
			.execute();
		expect((await read())[0]?.label).toBe('Tick off (or untick) a shopping item: Milk');
	});
});

describe('an overview the person asks for', () => {
	it('tells the model that "give me" is who gets the answer, not a person filter', async () => {
		// What the real model did for "Give me an overview of this week": it filtered both tools
		// by the asker and left out the family's other events and open tasks.
		k.llm.respondChat([
			{
				tool: 'calendar_findEvents',
				input: { from: '2026-10-12', to: '2026-10-18', members: ['member:1'] },
			},
			{ tool: 'lists_openTasks', input: { assignee: 'member:1' } },
			{ text: 'This week you have nothing on.' },
		]);
		await ask("Give me an overview of this week: what's on, the open tasks and the shopping list.");
		const request = k.llm.chatCalls[0];
		expect(request?.system).toContain(
			'"Give me", "show me" and "tell me" only say who gets the answer, never whose things',
		);
		const field = (tool: string, name: string) => {
			const schema = request?.tools?.find((t) => t.name === tool)?.inputSchema as
				| { properties?: Record<string, { description?: string }> }
				| undefined;
			return schema?.properties?.[name]?.description ?? '';
		};
		for (const description of [
			field('calendar_findEvents', 'members'),
			field('lists_openTasks', 'assignee'),
		]) {
			expect(description).toMatch(/^Leave it out \(the default\)/);
			expect(description).toContain('that is who gets the answer');
		}
	});
});
