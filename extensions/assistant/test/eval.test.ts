import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { createFakeLlm, createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, describe, expect, it } from 'vitest';
import { CASES } from '../eval/cases.ts';
import {
	ALWAYS,
	atMost,
	type Draft,
	either,
	honest,
	noBold,
	noHandles,
	type Outcome,
	occurrenceOn,
	says,
	type Turn,
} from '../eval/checks.ts';
import { actionIdOf, report, runCase } from '../eval/harness.ts';
import { DEFAULT_FAMILY, seed } from '../eval/seed.ts';
import assistant from '../src/server/index.ts';

const TZ = 'Europe/Amsterdam';

function outcome(turn: Partial<Turn>, seeded: Record<string, string> = {}): Outcome {
	return {
		turns: [{ ask: 'q', reply: '', status: 'done', calls: [], drafts: [], ...turn }],
		seeded,
		timeZone: TZ,
	};
}

const draft = (input: Record<string, unknown>, actionId = 'lists.checkShoppingItem'): Draft => ({
	actionId,
	input,
	mayExist: false,
});

describe('the eval checks', () => {
	it('reads an occurrence given as a date or as the calendar key', () => {
		expect(occurrenceOn({ occurrence: '2026-10-25' }, '2026-10-25', TZ)).toBe(true);
		expect(
			occurrenceOn({ occurrence: String(epochOf('2026-10-25', '19:30', TZ)) }, '2026-10-25', TZ),
		).toBe(true);
		// Late in the evening in Amsterdam is still that day, though UTC has moved on.
		expect(occurrenceOn({ occurrence: epochOf('2026-10-25', '23:30', TZ) }, '2026-10-25', TZ)).toBe(
			true,
		);
		expect(occurrenceOn({ occurrence: '2026-10-18' }, '2026-10-25', TZ)).toBe(false);
		expect(occurrenceOn({}, '2026-10-25', TZ)).toBe(false);
	});

	it('finds handles and ids in a reply, but not times', () => {
		expect(noHandles().pass(outcome({ reply: 'Swim training is at 18:00.' }))).toBe(true);
		expect(noHandles().pass(outcome({ reply: 'I moved cal_event:1.' }))).toBe(false);
		expect(noHandles().pass(outcome({ reply: 'Ask member:2 first.' }))).toBe(false);
		expect(
			noHandles().pass(outcome({ reply: 'It is shop_item_019a1b2c-3d4e-7f00-8000-000000000001.' })),
		).toBe(false);
	});

	it('finds Markdown bold', () => {
		expect(noBold().pass(outcome({ reply: '**Tuesday**: swim' }))).toBe(false);
		expect(noBold().pass(outcome({ reply: 'Tuesday: swim' }))).toBe(true);
	});

	it('flags a claimed suggestion only when there is no draft', () => {
		const claim = "I've suggested moving it to 18:00. It needs to be approved.";
		expect(honest().pass(outcome({ reply: claim }))).toBe(false);
		expect(honest().pass(outcome({ reply: claim, drafts: [draft({ id: 'x' })] }))).toBe(true);
		expect(honest().pass(outcome({ reply: 'I cannot add events: the calendar is off.' }))).toBe(
			true,
		);
	});

	it('counts drafts on a seeded record and combines checks', () => {
		const seeded = { 'Oat milk': 'shop_item_1' };
		const two = outcome(
			{ drafts: [draft({ id: 'shop_item_1', label: 'Milk' }), draft({ id: 'shop_item_1' })] },
			seeded,
		);
		const about = (d: Draft) => JSON.stringify(d.input).includes('"shop_item_1"');
		expect(atMost(1, 'on Oat milk', about).pass(two)).toBe(false);
		expect(atMost(2, 'on Oat milk', about).pass(two)).toBe(true);
		expect(either(says(/already/), says(/oat/i)).pass(outcome({ reply: 'Oat milk' }))).toBe(true);
		expect(either(says(/already/), says(/oat/i)).pass(outcome({ reply: 'Milk' }))).toBe(false);
	});

	it('maps tool names back to action ids', () => {
		expect(actionIdOf('calendar_findEvents')).toBe('calendar.findEvents');
		expect(actionIdOf('lists_checkShoppingItem')).toBe('lists.checkShoppingItem');
	});
});

describe('the eval cases', () => {
	let k: TestKernel | undefined;
	afterEach(() => k?.close());

	it('have unique names and at least one check each', () => {
		expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
		for (const c of CASES) expect(c.checks.length, c.name).toBeGreaterThan(0);
	});

	it.each(CASES.map((c) => [c.name, c] as const))('seed without a model: %s', async (_name, c) => {
		k = await createTestKernel({ extensions: [calendar, lists, assistant] });
		const { seeded, asker } = await seed(k, c);
		const family = c.family ?? DEFAULT_FAMILY;
		expect(asker.member.displayName).toBe(c.as ?? family[0]?.name);
		for (const person of family) expect(seeded[person.name]).toBeDefined();
		for (const event of c.events ?? []) expect(seeded[event.title]).toMatch(/^cal_event_/);
		for (const items of Object.values(c.shopping ?? {}))
			for (const item of items) expect(seeded[item.title]).toMatch(/^shop_item_/);
		for (const task of c.tasks ?? [])
			expect(seeded[typeof task === 'string' ? task : task.title]).toBeDefined();
		// Every check can read what the case seeded (a mistyped title would throw).
		const empty: Outcome = { turns: [], seeded, timeZone: TZ };
		for (const check of [...c.checks, ...ALWAYS]) expect(() => check.pass(empty)).not.toThrow();
	});
});

describe('a case run end to end with a scripted model', () => {
	const byName = (name: string) => {
		const found = CASES.find((c) => c.name.startsWith(name));
		if (!found) throw new Error(`no case ${name}`);
		return found;
	};

	it('reads a typographic apostrophe as a plain one (real model output)', async () => {
		const llm = createFakeLlm();
		llm.respondChat([
			{ tool: 'calendar_findEvents', input: { text: 'Dental cleaning' } },
			{
				text: 'I couldn’t find any calendar event titled “Dental cleaning.” If you meant a different event (for example, the “Dentist checkup” on October 8 at 09:30), please let me know the exact title or date so I can update it for you.',
			},
		]);
		const result = await runCase(byName('not there: "Dental cleaning"'), llm);
		expect(result.failed).toEqual([]);
	});

	it('passes the single-date move when the model gives the date', async () => {
		const llm = createFakeLlm();
		llm.respondChat([
			{ tool: 'calendar_findEvents', input: { text: 'Sunday planning' } },
			{
				tool: 'calendar_changeEvent',
				input: {
					id: 'cal_event:1',
					occurrence: '2026-10-25',
					startTime: '18:00',
					label: 'Sunday planning',
				},
			},
			{ text: 'I suggested moving the Sunday planning on 25 October to 18:00.' },
		]);
		const result = await runCase(byName('one date: Sunday planning on 25 October'), llm);
		expect(result.failed).toEqual([]);
		expect(result.outcome.turns[0]?.calls.map((c) => c.actionId)).toEqual([
			'calendar.findEvents',
			'calendar.changeEvent',
		]);
		expect(result.outcome.turns[0]?.reply).toContain('Suggested, not added yet: ');
	});

	it('fails the follow-up when the model changes the whole series (real model output)', async () => {
		const llm = createFakeLlm();
		llm.respondChat(
			[
				{ tool: 'calendar_findEvents', input: { text: 'Sunday planning' } },
				{ text: 'Sunday planning is at 19:30 every Sunday. Shall I move it?' },
			],
			[
				{
					tool: 'calendar_changeEvent',
					input: { id: 'cal_event:1', startTime: '18:00', label: 'Sunday planning' },
				},
				{ text: 'Done.' },
			],
		);
		const result = await runCase(byName('one date: follow-up'), llm);
		expect(result.ok).toBe(false);
		expect(result.failed).toContain('no change of the whole series in the last turn');
		const lines = report(result).join('\n');
		expect(lines).toContain('· call calendar.changeEvent {"id":"cal_event:1","startTime":"18:00"');
		expect(lines).toContain('"id":"@Sunday planning"');
		expect(lines).toContain('· reply "Done.');
	});

	it('fails a claimed suggestion that was never made (real model output)', async () => {
		const llm = createFakeLlm();
		// "I made a suggestion to move the Sunday planning on 25 October", after a search only.
		llm.respondChat([
			{ tool: 'calendar_findEvents', input: { text: 'Sunday planning' } },
			{
				text: 'I made a suggestion to move the Sunday planning on 25 October to 18:00. This needs to be approved by Sofia or Lukas.',
			},
		]);
		const result = await runCase(byName('one date: Sunday planning on 25 October'), llm);
		expect(result.failed).toEqual(
			expect.arrayContaining([
				expect.stringContaining('drafted calendar.changeEvent'),
				'no claim of a suggestion without a draft',
			]),
		);
	});

	it('ticks the bananas on the long list when the model finds them', async () => {
		const llm = createFakeLlm();
		llm.respondChat([
			{ tool: 'lists_shoppingList', input: {} },
			{
				tool: 'lists_checkShoppingItem',
				input: { id: 'shop_item:63', done: true, label: 'bananas' },
			},
			{ text: 'Bananas for pancakes is ready to tick off.' },
		]);
		const result = await runCase(byName('tick off: "the bananas"'), llm);
		// The 63rd row of the list the model was shown.
		expect(llm.chatTrace[0]?.result).toContain(
			'{"id":"shop_item:63","title":"Bananas for pancakes"',
		);
		expect(result.failed).toEqual([]);
		expect(result.outcome.turns[0]?.drafts).toHaveLength(1);
	});

	it('fails the Turkish case when the answer is in English (real model mix-up)', async () => {
		const llm = createFakeLlm();
		llm.respondChat([
			{
				tool: 'lists_addShoppingItems',
				input: { items: [{ title: 'Süt' }, { title: 'Yumurta' }] },
			},
			{ text: 'I added milk and eggs to the list.' },
		]);
		const result = await runCase(byName('Turkish'), llm);
		expect(result.failed).toEqual([expect.stringContaining('reply never says')]);
		// The host's own line is in the family language.
		expect(result.outcome.turns[0]?.reply).toContain('Önerildi, henüz eklenmedi: ');
	});
});
