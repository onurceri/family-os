import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { createHandleTable, idSchema, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import en from '../src/messages/en.json' with { type: 'json' };
import tr from '../src/messages/tr.json' with { type: 'json' };
import assistant from '../src/server/index.ts';
import { namedBy, saidBy, withoutUnnamedPeople } from '../src/server/tools.ts';
import { loopTurns } from './reading.ts';

/*
 * What gpt-4.1-mini sent as tool calls, word for word, in the assistant eval: it fills every
 * field it sees, writes ids that fit the schema's pattern, writes handles without their colon or
 * as names, and repeats a failing call until the step limit. Code takes what can be read and
 * refuses the rest, so the turn still ends with an answer.
 */

let k: TestKernel;
let sofia: Awaited<ReturnType<TestKernel['member']>>;
let ellie: Awaited<ReturnType<TestKernel['member']>>;
let groceries: string;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Amsterdam', locale: 'en' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-06', '10:00', 'Europe/Amsterdam'));
	sofia = await k.member('admin', 'Sofia');
	ellie = await k.member('supervised', 'Ellie');
	const made = await k.runner.invoke<{ id: string }>(
		'lists.createShoppingList',
		{ name: 'Groceries' },
		sofia.actor,
	);
	if (made.status !== 'applied') throw new Error('expected the list');
	groceries = made.output.id;
	await k.runner.invoke(
		'lists.addShoppingItems',
		{ listId: groceries, items: [{ title: 'Cheddar' }, { title: 'Bananas for pancakes' }] },
		sofia.actor,
	);
});
afterEach(() => k.close());

async function ask(text: string, who = sofia, threadId?: string) {
	const result = await k.runner.invoke<{ threadId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text, ...(threadId && { threadId }) },
		who.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	const detail = (await k
		.route('assistant.getThread')
		.call({ params: { threadId: result.output.threadId }, actor: who.actor })) as {
		messages: { id: string; status: string; content: string; errorCode: string | null }[];
	};
	const reply = detail.messages.find((m) => m.id === result.output.replyId);
	return reply && { ...reply, threadId: result.output.threadId };
}
const drafts = () =>
	k.route('core.listDrafts').call({ query: { limit: 50 }, actor: sofia.actor }) as Promise<
		{ actionId: string; input: Record<string, unknown> }[]
	>;

describe('references a model writes its own way', () => {
	it('reads a member handle without its colon, a bare number and a name', async () => {
		loopTurns(k.llm, [
			{
				tool: 'lists_addTask',
				input: { title: 'Pack swim bag', assigneeId: 'member_2', dueDate: '2026-10-06' },
			},
			{
				tool: 'calendar_createEvent',
				input: { title: 'Pick-up', date: '2026-10-06', startTime: '18:30', memberIds: ['2'] },
			},
			{ tool: 'lists_openTasks', input: { assignee: 'Ellie' } },
			{ text: 'Suggested.' },
		]);
		await ask('Remind Ellie to pack her swim bag today');
		expect(k.llm.chatTrace.map((t) => t.ok)).toEqual([true, true, true]);
		const made = await drafts();
		expect(made.find((d) => d.actionId === 'lists.addTask')?.input.assigneeId).toBe(
			ellie.member.id,
		);
		expect(made.find((d) => d.actionId === 'calendar.createEvent')?.input.memberIds).toEqual([
			ellie.member.id,
		]);
		// A name in a member field is that member (nothing is open for her yet).
		expect(k.llm.chatTrace[2]?.result).toContain('"tasks":[]');
	});

	it('leaves out an empty reference and refuses an invented one, without running it again', async () => {
		const invented = {
			tool: 'lists_shoppingList',
			input: {
				list: 'Groceries',
				listId: 'shop_list_00000000-0000-7000-8000-000000000000',
				text: 'bananas',
			},
		};
		loopTurns(k.llm, [
			{ tool: 'lists_shoppingList', input: { list: 'Groceries', listId: '', text: 'bananas' } },
			invented,
			invented,
			invented,
			invented,
			{ text: 'Bananas for pancakes are on Groceries.' },
		]);
		const reply = await ask('Tick off the bananas');
		expect(k.llm.chatTrace[0]?.result).toContain('Bananas for pancakes');
		expect(k.llm.chatTrace[1]?.result).toContain(
			"Error (unknown): what it names is not there. No such reference in 'listId'",
		);
		expect(k.llm.chatTrace[2]?.result).toContain('already made in this turn');
		// Two repeats close the tools: the model answers with what it has.
		expect(k.llm.chatTrace).toHaveLength(4);
		expect(reply).toMatchObject({
			status: 'done',
			content: 'Bananas for pancakes are on Groceries.',
		});
	});
});

describe('a note to remember', () => {
	it('is refused when it is not what the person said', async () => {
		// The model "remembered" where the flat papers are, which nobody said.
		loopTurns(k.llm, [
			{
				tool: 'core_addMemory',
				input: { text: 'Flat papers are kept in the living room cabinet.' },
			},
			{ text: 'I cannot see anything about the flat.' },
		]);
		await ask('Where do we keep the flat papers, and what is due this month for the flat?');
		expect(k.llm.chatTrace[0]?.result).toContain('Error (incomplete)');
		expect(await drafts()).toEqual([]);
	});

	it('is suggested when it says what the person said', async () => {
		loopTurns(k.llm, [
			{ tool: 'core_addMemory', input: { text: 'Sofia is vegetarian' } },
			{ text: 'Suggested.' },
		]);
		await ask('Please remember that I am vegetarian');
		expect(await drafts()).toMatchObject([{ actionId: 'core.addMemory' }]);
	});

	it('counts the person’s own words, also with another ending', () => {
		expect(saidBy('Noah is allergic to nuts', 'remember Noah is allergic to nuts', 'en')).toBe(
			true,
		);
		expect(saidBy('Prefers walking routes', 'I prefer walking', 'en')).toBe(true);
		expect(
			saidBy(
				'Flat papers are kept in the living room cabinet.',
				'Where do we keep the flat papers?',
				'en',
			),
		).toBe(false);
		expect(saidBy('', 'anything', 'en')).toBe(false);
	});
});

describe('the words for the thing to change', () => {
	it('must be the person’s, not the title the model found instead', async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Dentist checkup', date: '2026-10-08', startTime: '09:30' },
			systemActor('test'),
		);
		// xing4.0 for "Change Dental cleaning to 10:00": it found the dentist and labelled the change
		// with that title, which the runner's own check of label against title lets through.
		loopTurns(k.llm, [
			{ tool: 'calendar_findEvents', input: { from: '2026-10-05', to: '2026-10-11' } },
			{
				tool: 'calendar_changeEvent',
				input: { id: 'cal_event:1', startTime: '10:00', label: 'Dentist checkup' },
			},
			{ text: 'There is no Dental cleaning.' },
		]);
		await ask('Change Dental cleaning to 10:00');
		expect(k.llm.chatTrace[1]?.result).toContain(
			"Error (unknown): what it names is not there. 'label' must be the name the person used",
		);
		expect(await drafts()).toEqual([]);
	});

	it('may be the assistant’s own when the person confirms its question', async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Dentist checkup', date: '2026-10-08', startTime: '09:30' },
			systemActor('test'),
		);
		loopTurns(
			k.llm,
			[
				{ tool: 'calendar_findEvents', input: { text: 'Dental cleaning' } },
				{ tool: 'calendar_findEvents', input: { from: '2026-10-05', to: '2026-10-11' } },
				{ text: 'There is no Dental cleaning. Did you mean the Dentist checkup on Thursday?' },
			],
			[
				{
					tool: 'calendar_changeEvent',
					input: { id: 'cal_event:1', startTime: '10:00', label: 'Dentist checkup' },
				},
				{ text: 'Suggested.' },
			],
		);
		const first = await ask('Change Dental cleaning to 10:00');
		k.clock.advance(60_000);
		await ask('yes', sofia, first?.threadId);
		expect(await drafts()).toMatchObject([
			{ actionId: 'calendar.changeEvent', input: { startTime: '10:00' } },
		]);
	});

	it('counts whole words, with a plural s aside', () => {
		expect(namedBy('the bananas', 'Tick off the banana', 'en')).toBe(true);
		expect(namedBy('Sunday planning', 'Move Sunday planning to 18:00', 'en')).toBe(true);
		expect(namedBy('Dentist checkup', 'Change Dental cleaning to 10:00', 'en')).toBe(false);
		expect(namedBy('', 'anything', 'en')).toBe(false);
	});
});

describe('people on a change', () => {
	async function sundayPlanning() {
		const made = await k.runner.invoke<{ id: string }>(
			'calendar.createEvent',
			{
				title: 'Sunday planning',
				date: '2026-09-06',
				startTime: '19:30',
				endTime: '20:00',
				memberIds: [ellie.member.id],
				recurrence: { freq: 'weekly', interval: 1, byDay: ['SU'] },
			},
			systemActor('test'),
		);
		if (made.status !== 'applied') throw new Error('expected the event');
	}
	const find = {
		tool: 'calendar_findEvents',
		input: { from: '2026-10-11', to: '2026-10-11', text: 'planning' },
	};
	// gpt-4.1-mini's call for "Move Sunday planning to 18:00", asked by Sofia, field for field:
	// it filled every field, and put the asker into memberIds.
	const move = (memberIds: string[]) => ({
		tool: 'calendar_changeEvent',
		input: {
			title: 'Sunday planning',
			allDay: false,
			date: '2026-10-11',
			endDate: null,
			startTime: '18:00',
			endTime: '19:00',
			memberIds,
			location: null,
			notes: null,
			id: 'cal_event:1',
			occurrence: '2026-10-11',
			label: 'Sunday planning',
		},
	});
	const changes = async () => (await drafts()).filter((d) => d.actionId === 'calendar.changeEvent');

	it('never takes people the person did not name', async () => {
		await sundayPlanning();
		loopTurns(k.llm, [find, move(['Sofia']), { text: 'Suggested.' }]);
		await ask('Move Sunday planning to 18:00');
		const [change] = await changes();
		expect(change?.input.startTime).toBe('18:00');
		expect(change?.input).not.toHaveProperty('memberIds');
	});

	it('drops an empty list of people too', async () => {
		await sundayPlanning();
		loopTurns(k.llm, [find, move([]), { text: 'Suggested.' }]);
		await ask('Move Sunday planning to 18:00');
		expect((await changes())[0]?.input).not.toHaveProperty('memberIds');
	});

	it('clears the people when the message says it is for everyone', async () => {
		await sundayPlanning();
		loopTurns(k.llm, [find, move([]), { text: 'Suggested.' }]);
		await ask('Move Sunday planning to 18:00 and make it for the whole family');
		expect((await changes())[0]?.input.memberIds).toEqual([]);
	});

	it('never takes only the asker for "everyone"', async () => {
		await sundayPlanning();
		loopTurns(k.llm, [find, move(['Sofia']), { text: 'Suggested.' }]);
		await ask('Move Sunday planning to 18:00 for everyone');
		expect((await changes())[0]?.input).not.toHaveProperty('memberIds');
	});

	it('takes the people the message names, and the asker who says "me"', async () => {
		await sundayPlanning();
		loopTurns(k.llm, [find, move(['Ellie', 'Sofia']), { text: 'Suggested.' }]);
		await ask('Move Sunday planning to 18:00, for Ellie and me');
		expect((await changes())[0]?.input.memberIds).toEqual([ellie.member.id, sofia.member.id]);
	});
});

describe('people of a chore’s turns, in both languages', () => {
	const id = (prefix: string, n: number) =>
		`${prefix}_01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;
	// The shape of chores.setAssignees: the chore and the people in turn order.
	const schema = z.toJSONSchema(
		z.object({ id: idSchema('chore'), memberIds: z.array(idSchema('member')) }),
		{ io: 'input' },
	) as Record<string, unknown>;
	const ayse = id('member', 1);
	const deniz = id('member', 2);
	const people = [
		{ id: ayse, displayName: 'Ayşe' },
		{ id: deniz, displayName: 'Deniz' },
	];
	const table = createHandleTable();
	table.add('member', ayse);
	table.add('member', deniz);
	const words = (value: string) => value.split(',').map((w) => w.trim());
	const env = (text: string) => ({
		table,
		people,
		locale: 'tr',
		asked: {
			text,
			memberId: ayse,
			self: [...words(en.words_self), ...words(tr.words_self)],
			everyone: [...words(en.words_everyone), ...words(tr.words_everyone)],
		},
	});
	const turns = (memberIds: string[], text: string) =>
		withoutUnnamedPeople({ id: 'chore:1', memberIds }, schema, env(text)) as Record<
			string,
			unknown
		>;

	it('takes everyone, or the people named', () => {
		expect(turns([], 'Bulaşığı herkes yapabilsin')).toMatchObject({ memberIds: [] });
		expect(turns([], 'Let everyone do the dishes')).toMatchObject({ memberIds: [] });
		expect(turns(['member:1', 'member:2'], 'Bulaşık sırası tüm aileye')).toMatchObject({
			memberIds: ['member:1', 'member:2'],
		});
		expect(turns(['Deniz', 'Ayşe'], 'Bulaşığı Deniz ve ben sırayla yapalım')).toMatchObject({
			memberIds: ['Deniz', 'Ayşe'],
		});
	});

	it('leaves the turns as they are when nobody is named', () => {
		expect(turns(['member:1'], 'Bulaşık sırasını düzenle')).not.toHaveProperty('memberIds');
		expect(turns([], 'Sort out the dishes')).not.toHaveProperty('memberIds');
		// "Everyone" never lets only some of them in.
		expect(turns(['member:1'], 'herkes için')).not.toHaveProperty('memberIds');
	});
});
