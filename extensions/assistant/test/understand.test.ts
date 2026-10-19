import { repoTranslate } from '@famos/testing';
import { dateLocale, dateWords } from '@famos/time';
import { describe, expect, it } from 'vitest';
import { buildCard, type CardWords, cardText } from '../src/server/card.ts';
import {
	partsTheWordsGive,
	planTopics,
	questionSpan,
	withCompanions,
} from '../src/server/question.ts';
import {
	EXAMPLES,
	QuestionSchema,
	ReadingSchema,
	understandHash,
	understandPrompt,
	understandSystem,
} from '../src/server/understand.ts';

describe('the reading of a message', () => {
	it('keeps what it can of a broken answer', () => {
		expect(
			QuestionSchema.parse({
				intent: 'question',
				topics: ['calendar', 'weather', 'calendar', 3],
				people: ['Leo', { said: ' me ' }, { name: 'x' }],
				about: ['pick up', 7, ''],
				span: { kind: 'decade' },
			}),
		).toEqual({
			intent: 'other',
			topics: ['calendar'],
			people: [{ said: 'Leo' }, { said: 'me' }],
			about: ['pick up'],
		});
		// A reading with nothing at all is "other": the tool loop answers it.
		expect(QuestionSchema.parse({})).toMatchObject({ intent: 'other', topics: [], people: [] });
	});

	it('reads every example of its own prompt', () => {
		for (const example of EXAMPLES) {
			const parts = Array.isArray(example.answer) ? example.answer : [example.answer];
			expect(
				ReadingSchema.parse({ parts }).parts.map((p) => p.intent),
				example.text,
			).toEqual(parts.map((p) => p.intent));
		}
	});

	it('is a short prompt with no family data, and its fingerprint is stable', () => {
		const rules = understandSystem().split('\n\nExamples:')[0] ?? '';
		expect(rules.split('\n').length).toBeLessThanOrEqual(10);
		expect(understandHash()).toBe(understandHash());
		expect(understandPrompt('and Friday?', ['What is on Thursday?'])).toContain(
			'- What is on Thursday?',
		);
	});
});

describe('the days and topics of a question', () => {
	it('is the coming seven days when no days are named', () => {
		expect(questionSpan({}, '2026-10-18', 1)).toEqual({
			from: '2026-10-18',
			to: '2026-10-24',
			label: { key: 'coming_days', from: '2026-10-18', to: '2026-10-24' },
		});
	});

	it('reads "this month" as this month, whatever month number the model added (real model answer)', () => {
		const translate = repoTranslate();
		const words = dateWords((key) =>
			translate('en', key)
				.split(',')
				.map((w) => w.trim().toLocaleLowerCase())
				.filter(Boolean),
		);
		// nemotron-120b: {"said":"this month","kind":"month","day":{"text":"this month","month":1}}.
		const span = {
			said: 'this month',
			kind: 'month',
			day: { text: 'this month', month: 1 },
		} as const;
		expect(questionSpan({ span }, '2026-10-06', 1, { words })).toMatchObject({
			from: '2026-10-06',
			to: '2026-10-31',
		});
		expect(partsTheWordsGive({ text: 'in January', month: 1 }, words)).toEqual({
			text: 'in January',
			month: 1,
		});
		expect(partsTheWordsGive({ text: 'tomorrow', inDays: 1, weekday: 3 }, words)).toEqual({
			text: 'tomorrow',
			inDays: 1,
		});
	});

	it('reads the calendar beside the meal plan', () => {
		expect(withCompanions(['meals'])).toEqual(['meals', 'calendar']);
		expect(withCompanions(['calendar', 'meals'])).toEqual(['calendar', 'meals']);
	});

	it('tells not installed, closed to the AI and not readable by the asker apart', () => {
		const actor = { kind: 'ai', mode: 'conversation', source: 'assistant' } as const;
		const plan = planTopics(
			['calendar', 'tasks', 'pets', 'home'],
			{
				aiDigests: (options) =>
					options?.actor
						? [{ topic: 'tasks', actionId: 'lists.tasksDigest', area: 'lists' }]
						: [
								{ topic: 'calendar', actionId: 'calendar.digest', area: 'calendar' },
								{ topic: 'tasks', actionId: 'lists.tasksDigest', area: 'lists' },
							],
				aiMissingAreas: () => [
					{ id: 'pets', name: 'Pets', description: '', why: 'not_installed' },
					{ id: 'home', name: 'Home', description: '', why: 'closed_to_ai' },
				],
			},
			actor,
			false,
		);
		expect(plan.open).toEqual([{ topic: 'tasks', actionId: 'lists.tasksDigest' }]);
		expect(plan.notHere).toEqual([
			{ topic: 'pets', why: 'not_installed' },
			{ topic: 'home', why: 'closed_to_ai' },
			{ topic: 'calendar', why: 'not_allowed' },
		]);
	});
});

describe('the answer card as plain lines', () => {
	const translate = repoTranslate();
	const words = (language: string): CardWords => ({
		t: (key, params) => translate(language, `assistant:${key}`, params),
		dateLocale: dateLocale(language, 'sl-SI', 'h23'),
		hourCycle: 'h23',
		today: '2026-10-18',
	});
	const names = new Map([
		['member_1', 'Leo'],
		['member_2', 'Mara'],
	]);
	const card = buildCard({
		topics: ['tasks', 'shopping', 'suggestions'],
		people: ['Leo'],
		everyone: false,
		unmatched: ['Grandma'],
		span: { key: 'this_week', from: '2026-10-19', to: '2026-10-25' },
		fallback: false,
		fetched: [
			{
				topic: 'tasks',
				output: {
					items: [
						{
							handle: 'task_x',
							kind: 'task',
							title: 'Practise reading',
							date: '2026-10-16',
							people: ['member_1'],
							status: 'overdue',
						},
					],
					truncated: false,
				},
			},
			{
				topic: 'shopping',
				output: {
					items: [
						{
							handle: null,
							kind: 'shopping_list',
							title: 'Groceries',
							date: '2026-10-19',
							people: [],
							extra: { open: '2', things: 'Milk, Bread' },
						},
					],
					truncated: false,
				},
			},
			{
				topic: 'suggestions',
				output: {
					items: [
						{
							handle: null,
							kind: 'suggestion',
							title: "Add an event: Sleepover at Max's",
							date: '2026-10-19',
							people: ['member_1'],
							status: 'waiting',
							extra: { waitsFor: 'asker', day: '2027-01-08' },
						},
					],
					truncated: true,
					hidden: 2,
				},
			},
		],
		notHere: [{ topic: 'pets', why: 'not_installed' }],
		names,
	});

	it('writes every fact in the reader’s words, with no ISO date', () => {
		const lines = cardText(card, words('en'));
		expect(lines).toEqual([
			'Tasks, Shopping and Waiting for approval · Leo · This week, Mon, 19 Oct – Sun, 25 Oct',
			'No family member is called Grandma',
			'',
			'Tasks',
			'- Practise reading (Leo), late since Friday, 16 October',
			'',
			'Shopping',
			'- Groceries: Milk, Bread',
			'',
			'Waiting for approval',
			"- Add an event: Sleepover at Max's, from Leo, for Friday, 8 January 2027",
			'And more.',
			'2 more the assistant may not read.',
			'',
			'Pets: not installed here.',
		]);
		expect(lines.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it('writes Turkish with Turkish day and month names', () => {
		const lines = cardText(card, words('tr'));
		expect(lines[0]).toContain('Görevler');
		expect(lines.join('\n')).toContain('Ekim');
		expect(lines.at(-1)).toBe('Evcil hayvanlar: burada kurulu değil.');
	});
});
