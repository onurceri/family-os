import calendar from '@famos/ext-calendar/server';
import kitchen from '@famos/ext-kitchen/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import vehicles from '@famos/ext-vehicles/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../src/contract/index.ts';
import assistant from '../src/server/index.ts';
import { loopTurns, scopedTurns } from './reading.ts';

// Sunday 18 October 2026 in Ljubljana.
const TZ = 'Europe/Ljubljana';
type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let mara: Asker;

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, kitchen, records, vehicles, assistant],
		translate: repoTranslate(),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'en', formatLocale: 'sl-SI', weekStart: 1, hourCycle: 'h23' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-18', '10:00', TZ));
	mara = await k.member('admin', 'Mara');
	await k.runner.invoke(
		'calendar.createEvent',
		{ title: 'Swimming lesson', date: '2026-10-22', startTime: '16:30', endTime: '17:30' },
		systemActor('test'),
	);
});
afterEach(() => k.close());

async function ask(text: string, threadId?: string) {
	const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text, ...(threadId && { threadId }) },
		mara.actor,
	);
	if (sent.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	const detail = (await k
		.route('assistant.getThread')
		.call({ params: { threadId: sent.output.threadId }, actor: mara.actor })) as {
		messages: Message[];
	};
	const reply = detail.messages.find((m) => m.id === sent.output.replyId);
	if (!reply) throw new Error('expected the answer');
	k.clock.advance(60_000);
	return { reply, threadId: sent.output.threadId };
}

const offered = () => k.llm.chatCalls.at(-1)?.tools.map((t) => t.name) ?? [];
const areasOf = (names: readonly string[]) => new Set(names.map((n) => n.split('_')[0]));

describe('the tools of a change', () => {
	it('are those of the areas it is about, not every tool', async () => {
		scopedTurns(k.llm, { intent: 'change', topics: ['calendar'], people: [] }, [{ text: 'Ok.' }]);
		await ask('Move the swimming lesson to Friday');
		const names = offered();
		expect(names).toContain('calendar_changeEvent');
		expect(names).toContain('core_today');
		expect(areasOf(names)).toEqual(new Set(['calendar', 'core']));
		expect(names.length).toBeLessThan(12);
	});

	it('are the calendar, tasks and shopping when the message names no topic', async () => {
		scopedTurns(k.llm, { intent: 'change', topics: [], people: [] }, [{ text: 'Ok.' }]);
		await ask('Yes, do it');
		const names = offered();
		expect(areasOf(names)).toEqual(new Set(['calendar', 'lists', 'core']));
		expect(names).toContain('lists_checkShoppingItem');
		expect(names).not.toContain('vehicles_listVehicles');
		expect(names).not.toContain('core_addMemory');
	});

	it('hold the note to remember only for a thing to remember', async () => {
		scopedTurns(k.llm, { intent: 'remember', topics: [], people: [{ said: 'I' }] }, [
			{ text: 'Noted.' },
		]);
		await ask('Remember that I am vegetarian');
		expect(offered()).toContain('core_addMemory');
	});

	it('are all of them for anything else', async () => {
		loopTurns(k.llm, [{ text: 'Rice and beans.' }]);
		await ask('Any ideas for a dinner with rice?');
		const names = offered();
		expect(areasOf(names)).toEqual(
			new Set(['calendar', 'lists', 'kitchen', 'records', 'vehicles', 'core']),
		);
		expect(names).toContain('core_addMemory');
	});

	it('are those of the answer just before, so "yes, move it" works after a card', async () => {
		// A question about dinner shows the meal plan and the calendar.
		k.llm.respond({
			intent: 'ask',
			topics: ['meals'],
			span: { said: 'on Thursday', kind: 'day', day: { text: 'Thursday', weekday: 4 } },
			people: [],
		});
		k.llm.respondChat([{ text: 'Nothing planned.' }]);
		const first = await ask('What is for dinner on Thursday?');
		expect(first.reply.card).not.toBeNull();

		scopedTurns(k.llm, { intent: 'change', topics: [], people: [] }, [{ text: 'Ok.' }]);
		await ask('Yes, move it to Friday', first.threadId);
		const names = offered();
		// The meal plan is not in the fallback; the card put it in scope.
		expect(names).toContain('kitchen_addToMealPlan');
		expect(names).not.toContain('vehicles_listVehicles');
		// The record the card showed is still in the prompt.
		expect(k.llm.chatCalls.at(-1)?.system).toContain('Swimming lesson');
	});
});

describe('a suggestion for a task with a day', () => {
	it('says the day in the line under the answer', async () => {
		scopedTurns(k.llm, { intent: 'change', topics: ['tasks'], people: [] }, [
			{
				tool: 'lists_addTask',
				input: { title: 'Pack my football kit', dueDate: '2026-10-22' },
			},
			{ text: 'Suggested, for Thursday.' },
		]);
		const { reply } = await ask('Add a task: Pack my football kit on Thursday');
		expect(reply.suggested).toEqual([
			'Suggested, not added yet: Add a task: Pack my football kit for Thursday, 22 October',
		]);
		// What the model is told to say has the day too.
		const said = k.llm.chatTrace.find((t) => t.tool === 'lists_addTask')?.result ?? '';
		expect(said).toContain('Pack my football kit for 2026-10-22');
	});

	it('says nothing of a day for a task without one', async () => {
		scopedTurns(k.llm, { intent: 'change', topics: ['tasks'], people: [] }, [
			{ tool: 'lists_addTask', input: { title: 'Call the school' } },
			{ text: 'Suggested.' },
		]);
		const { reply } = await ask('Add a task: Call the school');
		expect(reply.suggested).toEqual(['Suggested, not added yet: Add a task: Call the school']);
	});
});
