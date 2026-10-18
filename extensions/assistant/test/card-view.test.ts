import { repoTranslate } from '@famos/testing';
import { dateLocale } from '@famos/time';
import { describe, expect, it } from 'vitest';
import type { CardWords } from '../src/contract/card-words.ts';
import { type AnswerCard, AnswerCardSchema } from '../src/contract/index.ts';
import { cardView, colorOf, rowHref } from '../src/web/card-view.ts';

const translate = repoTranslate();
const words = (language: string, hourCycle: 'h12' | 'h23' = 'h23'): CardWords => ({
	t: (key, params) => translate(language, `assistant:${key}`, params),
	dateLocale: dateLocale(language, 'sl-SI', hourCycle),
	hourCycle,
	today: '2026-10-18',
});

const card = (over: Partial<AnswerCard> = {}): AnswerCard =>
	AnswerCardSchema.parse({
		understood: {
			topics: ['calendar', 'tasks'],
			people: ['Leo'],
			everyone: false,
			unmatched: [],
			span: { key: 'this_week', from: '2026-10-19', to: '2026-10-25' },
			fallback: false,
		},
		sections: [
			{
				topic: 'calendar',
				truncated: false,
				items: [
					{
						kind: 'event',
						title: 'Swimming lesson',
						date: '2026-10-22',
						time: '16:30',
						endTime: '17:15',
						people: ['Leo', 'Mara'],
						place: 'Pool',
						notes: 'Bring the\n  swim bag and a towel',
					},
				],
			},
			{
				topic: 'tasks',
				truncated: true,
				hidden: 2,
				items: [
					{
						kind: 'task',
						title: 'Practise reading',
						date: '2026-10-16',
						people: ['Leo'],
						status: 'overdue',
					},
				],
			},
		],
		notHere: [{ topic: 'pets', why: 'not_installed' }],
		lead: { kept: true, check: null },
		text: [],
		...over,
	});

describe('the answer card as rows', () => {
	it('says what was understood in the reader’s words, with the span label', () => {
		const view = cardView(card(), words('en'));
		expect(view.understood).toEqual([
			'Calendar and Tasks',
			'Leo',
			'This week, Mon, 19 Oct – Sun, 25 Oct',
		]);
	});

	it('writes each item with its day and time, its people, its facts and its notes on one line', () => {
		const [calendar, tasks] = cardView(card(), words('en')).sections;
		expect(calendar?.label).toBe('Calendar');
		expect(calendar?.rows).toEqual([
			{
				when: 'Thursday, 22 October, 16:30–17:15',
				title: 'Swimming lesson',
				facts: ['Pool'],
				state: [],
				people: ['Leo', 'Mara'],
				notes: 'Bring the swim bag and a towel',
				href: null,
			},
		]);
		expect(tasks?.rows[0]).toMatchObject({
			when: '',
			state: ['Late since Friday, 16 October'],
		});
		expect(tasks?.more).toBe('And more.');
		expect(tasks?.hidden).toBe('2 more the assistant may not read.');
	});

	it('leaves the day out when the card is about one day, and uses the reader’s clock', () => {
		const one = card({
			understood: {
				...card().understood,
				span: { key: 'day', from: '2026-10-22', to: '2026-10-22' },
			},
		});
		expect(cardView(one, words('en')).sections[0]?.rows[0]?.when).toBe('16:30–17:15');
		expect(cardView(one, words('en', 'h12')).sections[0]?.rows[0]?.when).toMatch(/4:30.*5:15/);
	});

	it('says nothing in the span and what comes next, never an ISO date', () => {
		const quiet = card({
			sections: [
				{
					topic: 'calendar',
					truncated: false,
					items: [],
					next: {
						kind: 'event',
						title: 'Date night',
						date: '2026-10-24',
						time: '19:00',
						people: [],
					},
				},
				{ topic: 'tasks', truncated: false, items: [] },
			],
			understood: {
				...card().understood,
				span: { key: 'weekend', from: '2026-10-17', to: '2026-10-18' },
			},
		});
		const [calendar, tasks] = cardView(quiet, words('en')).sections;
		expect(calendar?.rows).toEqual([]);
		expect(calendar?.empty).toBe(
			'Nothing this weekend; next: Saturday, 24 October, 19:00: Date night.',
		);
		expect(tasks?.empty).toBe('Nothing this weekend.');
		expect(JSON.stringify(cardView(quiet, words('en')))).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it('names the topics that are not here and the names nobody has', () => {
		const view = cardView(
			card({
				understood: { ...card().understood, unmatched: ['Grandma'] },
				notHere: [
					{ topic: 'pets', why: 'not_installed' },
					{ topic: 'records', why: 'closed_to_ai' },
					{ topic: 'vehicles', why: 'not_allowed' },
				],
			}),
			words('en'),
		);
		expect(view.notices).toEqual(['Not in this family: Grandma']);
		expect(view.notHere).toEqual([
			'Pets: not installed here.',
			'Records: closed to the assistant in the AI settings.',
			'Vehicles: not something you can see.',
		]);
	});

	it('says "Everyone" for a word for the whole family and a wrong weekday as it was written', () => {
		const view = cardView(
			card({
				understood: {
					...card().understood,
					everyone: true,
					people: [],
					mismatches: [{ date: '2026-10-20', said: 3 }],
				},
			}),
			words('en'),
		);
		expect(view.understood[1]).toBe('Everyone');
		expect(view.notices).toEqual(['Tuesday, 20 October is not a Wednesday.']);
	});

	it('writes Turkish with Turkish names', () => {
		const view = cardView(card(), words('tr'));
		expect(view.sections[0]?.label).toBe('Takvim');
		expect(view.sections[1]?.rows[0]?.state[0]).toContain('Ekim');
		expect(view.notHere[0]).toBe('Evcil hayvanlar: burada kurulu değil.');
	});

	it('marks a suggestion that waits for someone else and one that could not be added', () => {
		const view = cardView(
			card({
				sections: [
					{
						topic: 'suggestions',
						truncated: false,
						items: [
							{
								kind: 'suggestion',
								title: 'Add an event: Sleepover',
								date: '2027-01-08',
								people: ['Leo'],
								status: 'waiting',
								forOthers: true,
							},
							{ kind: 'suggestion', title: 'Add a task: Swim bag', people: [], status: 'failed' },
						],
					},
				],
			}),
			words('en'),
		);
		expect(view.sections[0]?.rows.map((row) => row.state)).toEqual([
			['For Friday, 8 January 2027', 'Waits for someone else'],
			['Approved, but it could not be added, so it waits again'],
		]);
	});
});

describe('member colours on a card', () => {
	const members = [
		{ displayName: 'Leo', color: '#112233' },
		{ displayName: 'Mara', color: '#445566' },
		{ displayName: 'Sam', color: '#778899' },
		{ displayName: 'Sam', color: '#aabbcc' },
	];
	it('gives a name its member’s colour, and no colour when it is not exactly one member', () => {
		expect(colorOf('Leo', members)).toBe('#112233');
		expect(colorOf('Sam', members)).toBeNull();
		expect(colorOf('Grandma', members)).toBeNull();
	});
});

describe('a row that opens its thing', () => {
	const withHref = (href: string) =>
		card({
			sections: [
				{
					topic: 'calendar',
					truncated: false,
					items: [{ kind: 'event', title: 'Swimming lesson', people: [], href }],
				},
			],
		});

	it('links to a path inside the app and is plain without one', () => {
		const linked = cardView(withHref('/calendar?event=cal_event_1&on=2026-10-22'), words('en'));
		expect(linked.sections[0]?.rows[0]?.href).toBe('/calendar?event=cal_event_1&on=2026-10-22');
		expect(cardView(card(), words('en')).sections[0]?.rows[0]?.href).toBeNull();
	});

	it('never links to another site, even from a stored card that holds one', () => {
		for (const href of ['https://example.com', '//example.com', 'javascript:alert(1)', '/a b'])
			expect(rowHref({ href })).toBeNull();
		expect(rowHref({})).toBeNull();
		expect(rowHref({ href: '/pets/pet_1' })).toBe('/pets/pet_1');
	});
});
