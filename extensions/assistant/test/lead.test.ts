import { repoTranslate } from '@famos/testing';
import { dateWords } from '@famos/time';
import { describe, expect, it } from 'vitest';
import {
	ageIn,
	checkLead,
	firstSentences,
	type LeadFacts,
	leadBudget,
	leadSystem,
} from '../src/server/lead.ts';

const translate = repoTranslate();
const list = (lng: string, key: string) =>
	translate(lng, key)
		.split(',')
		.map((w) => w.trim().toLocaleLowerCase())
		.filter(Boolean);
const vocabulary = (key: string) => [...list('en', key), ...list('tr', key)];
const AGE = vocabulary('assistant:words_age');

describe('the length of the opening words', () => {
	it('reads an age from the family’s own description', () => {
		expect(ageIn('6 years old', AGE)).toBe(6);
		expect(ageIn('9, plays football', AGE)).toBe(9);
		expect(ageIn('14, swims and plays the piano', AGE)).toBe(14);
		expect(ageIn('9 yaşında', AGE)).toBe(9);
		expect(ageIn('Leo, 6 years old', AGE)).toBe(6);
		expect(ageIn('Father, nurse on 12-hour shifts', AGE)).toBeNull();
		expect(ageIn('Mother of 2', AGE)).toBeNull();
		expect(ageIn(null, AGE)).toBeNull();
	});

	it('gives a young child and a chat one sentence, others two', () => {
		expect(leadBudget('6 years old', 'app', AGE)).toEqual({ sentences: 1, young: true, words: 15 });
		expect(leadBudget('14, swims', 'app', AGE)).toEqual({ sentences: 2, young: false });
		expect(leadBudget('Mother, teacher', 'chat', AGE)).toEqual({ sentences: 1, young: false });
		expect(
			leadSystem({
				asker: { name: 'Leo', about: '6 years old' },
				language: 'English',
				budget: { sentences: 1, young: true, words: 15 },
			}),
		).toContain(
			'at most 1 sentence of at most 15 words in English, in simple words a young child understands',
		);
	});

	it('keeps the first sentences', () => {
		expect(firstSentences('One. Two! Three?', 2)).toBe('One. Two!');
		expect(firstSentences('Only one', 2)).toBe('Only one');
	});
});

const facts = (over: Partial<LeadFacts> = {}): LeadFacts => ({
	dates: new Set(['2026-10-18', '2026-10-22', '2026-10-24']),
	today: '2026-10-18',
	words: dateWords(vocabulary),
	order: 'DMY',
	titles: ['Swimming lesson', 'Sunday planning'],
	known: ['Swimming lesson (Leo) — Pick up from the pool', 'Leo', 'Mara', 'Calendar'],
	sections: [
		{ topic: 'calendar', empty: false },
		{ topic: 'tasks', empty: true },
	],
	fullTitles: ['Swimming lesson'],
	nothing: vocabulary('assistant:words_nothing'),
	negations: vocabulary('assistant:words_no'),
	topicWords: {
		calendar: vocabulary('assistant:words_topic_calendar'),
		tasks: vocabulary('assistant:words_topic_tasks'),
	},
	locale: 'en',
	...over,
});

describe('the checks of the opening words', () => {
	it('passes words that keep to the facts', () => {
		expect(checkLead('Leo has a Swimming lesson on Thursday 22 October.', facts())).toBeNull();
		expect(
			checkLead('Mara, no tasks are due this week; Leo swims on Thursday.', facts()),
		).toBeNull();
		// A weekday inside a title is no day of its own.
		expect(checkLead('Then Sunday planning, as always.', facts())).toBeNull();
	});

	it('drops ISO dates and handles (real model answers)', () => {
		expect(checkLead('Your task is due on Tuesday 2026-10-20.', facts())).toBe('iso_date');
		expect(checkLead('See cal_event:2 for that.', facts())).toBe('handle');
	});

	it('drops a weekday that is not the date’s, and a day the facts do not hold', () => {
		expect(checkLead('Swimming is on Wednesday 22 October.', facts())).toBe('wrong_weekday');
		expect(checkLead('Swimming is on 23 October.', facts())).toBe('unknown_date');
		expect(checkLead('Swimming is on Friday.', facts())).toBe('unknown_date');
	});

	it('drops the name of a thing the facts do not hold', () => {
		expect(checkLead('Leo has a Dentist visit.', facts())).toBe('unknown_title');
	});

	it('drops "nothing" over a topic with things (round-5 answers)', () => {
		expect(checkLead('There are no family events this week.', facts())).toBe('nothing_over_items');
		expect(checkLead('Nothing is planned.', facts())).toBe('nothing_over_items');
		// About the topic that has nothing, it is true.
		expect(checkLead('No tasks this week.', facts())).toBeNull();
		expect(checkLead('Bu hafta görev yok.', facts({ locale: 'tr' }))).toBeNull();
		expect(checkLead('Bu hafta takvimde etkinlik yok.', facts({ locale: 'tr' }))).toBe(
			'nothing_over_items',
		);
	});

	it('lets "nothing" stand when every topic is empty', () => {
		const empty = facts({
			sections: [{ topic: 'calendar', empty: true }],
		});
		expect(checkLead('Nothing this weekend.', empty)).toBeNull();
	});

	it('drops a young child’s opening that is too long (real model answer)', () => {
		const leo = facts({ maxWords: 15 });
		expect(
			checkLead(
				"You have reading practice on Monday, swimming on Thursday 22 October, and dinner at Nona Marija's on Friday.",
				leo,
			),
		).toBe('too_long');
		expect(checkLead('You have a Swimming lesson on Thursday.', leo)).toBeNull();
	});

	it('drops "nothing" said of a thing another topic holds (real model answer)', () => {
		// The meal plan was empty, and the calendar held Dinner at Nona Marija's.
		const dinner = facts({
			sections: [
				{ topic: 'meals', empty: true },
				{ topic: 'calendar', empty: false },
			],
			fullTitles: ["Dinner at Nona Marija's"],
			topicWords: { meals: vocabulary('assistant:words_topic_meals') },
		});
		expect(checkLead('Nothing is for dinner on Thursday 22 October.', dinner)).toBe(
			'nothing_over_items',
		);
	});

	it('drops empty words', () => {
		expect(checkLead('  ', facts())).toBe('empty');
	});
});
