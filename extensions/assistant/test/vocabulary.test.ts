import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';
import { loopTurns } from './reading.ts';

type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let tom: Asker;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ locale: 'en', timeZone: 'Europe/Ljubljana' },
		systemActor('test'),
	);
	tom = await k.member('admin', 'Tom');
	for (const [title, tags] of [
		["Parents' evening", ['school']],
		['Vet', ['pets']],
	] as const)
		await k.runner.invoke(
			'calendar.createEvent',
			{ title, date: '2026-10-20', startTime: '18:00', tags: [...tags] },
			tom.actor,
		);
});
afterEach(() => k.close());

async function ask(text: string) {
	const result = await k.runner.invoke<{ threadId: string }>(
		'assistant.sendMessage',
		{ text },
		tom.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	return k.llm.chatCalls.at(-1)?.system ?? '';
}

describe('the words the family already uses', () => {
	it('lists the calendar tags, so a suggestion reuses one instead of inventing one', async () => {
		// The real model tagged a pick-up reminder "reminder", a tag the family did not have: the
		// tags were only behind a tool it never called.
		loopTurns(k.llm, [
			{
				tool: 'calendar_createEvent',
				input: {
					title: 'Pick up Ivy after football',
					date: '2026-10-22',
					startTime: '18:30',
					tags: ['reminder'],
				},
			},
			{ text: 'Suggested.' },
		]);
		const system = await ask('Remind me on Thursday at 18:30 to pick Ivy up after football');
		expect(system).toContain('- Existing calendar tags: pets, school\n');
		expect(system).toContain('when none fits, leave it out unless the person names a new one');
	});

	it('lists none from an area closed to the AI', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'calendar', access: 'off' },
			systemActor('test'),
		);
		loopTurns(k.llm, [{ text: 'Nothing.' }]);
		const system = await ask('What tags do we use?');
		expect(system).not.toContain('Existing calendar tags');
		expect(system).not.toContain('school');
	});
});

describe('what the tools cover', () => {
	it('names the areas, so a question about another gets a plain answer', async () => {
		// After Home was removed, the real model said "I can tell you what is due for the flat"
		// and asked for the flat's name, with no tool that could look it up.
		loopTurns(k.llm, [{ text: 'I can tell you what is due for the flat. What is its name?' }]);
		const system = await ask('Where do we keep the flat papers, and what is due this month?');
		expect(system).toContain('Your tools cover these areas of FamilyOS: calendar, lists. When');
		expect(system).toContain('Never ask the person a question back about it');
	});
});
