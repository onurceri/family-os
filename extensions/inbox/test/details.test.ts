import { describe, expect, it } from 'vitest';
import { CASES, type Case } from '../eval/cases.ts';
import { failedChecks, harmfulChecks, runCaseOn } from '../eval/household.ts';

/*
 * A detail of another mention (`of`): the model says whose detail it is, code decides where it
 * goes. Read through the whole pipeline, in the households of the simulation cases.
 */

const caseNamed = (name: string) => {
	const found = CASES.find((c) => c.name === name);
	if (!found) throw new Error(`no case named ${name}`);
	return found;
};
const read = (c: Case, answer: unknown) =>
	runCaseOn(c, {
		prepare(k) {
			k.llm.respond(answer);
		},
	});

const RECITAL = 'A recital: the rule and what to bring are its notes (sim)';
const recitalEvent = {
	kind: 'calendar.event',
	title: 'Piano recital',
	date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
	time: '15:00',
	timeText: '15:00',
	place: 'Music school',
	quote: 'piano recital Sat 14 Nov 15:00 music school',
};

describe('details folded into the mention they belong to', () => {
	it('a recital keeps its rule and the book to bring in its notes, and the quote names them', async () => {
		const outcome = await read(caseNamed(RECITAL), {
			label: 'Piano recital',
			intent: 'actionable',
			mentions: [
				recitalEvent,
				{
					kind: 'lists.task',
					title: 'Practise piano',
					repeat: { every: 'day' },
					quote: 'practise every day pls',
				},
				{
					kind: 'board.note',
					notes: 'No phones in the hall',
					of: 0,
					relation: 'rule',
					quote: 'no phones in the hall',
				},
				{
					kind: 'lists.task',
					title: 'Bring blue music book',
					of: 0,
					relation: 'bring',
					quote: 'bring blue music book',
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
		const event = outcome.drafts.find((d) => d.actionId === 'calendar.createEvent');
		expect(event?.input.notes).toBe('No phones in the hall\nBring blue music book');
		expect(outcome.drafts.map((d) => d.actionId).toSorted()).toEqual([
			'calendar.createEvent',
			'lists.addTask',
		]);
	});

	it('a fee for the game with its own day stays a task, what to bring goes to the game', async () => {
		const outcome = await read(
			caseNamed('A coach message: the game, what to bring, the bus fee (sim)'),
			{
				label: 'U13 away game',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.event',
						title: 'U13 Eagles away game',
						people: ['Ivy'],
						peopleGuessed: true,
						date: { text: 'Sun 25.10', numeric: '25.10', weekday: 7 },
						time: '10:00',
						timeText: 'KO 10:00',
						place: 'Olimpija Park',
						quote: 'U13 Eagles away game Sun 25.10 KO 10:00 at Olimpija Park',
					},
					{
						kind: 'lists.task',
						title: 'Bring white shirt, shin pads & water',
						of: 0,
						relation: 'bring',
						quote: 'Bring white shirt, shin pads & water',
					},
					{
						kind: 'lists.task',
						title: 'Pay 10 EUR for the bus',
						date: { text: 'Fri', weekday: 5 },
						of: 0,
						relation: 'fee',
						quote: 'Pay 10 EUR for the bus by Fri',
					},
				],
			},
		);
		expect(failedChecks(outcome)).toEqual([]);
		expect(outcome.drafts.filter((d) => d.actionId === 'lists.addTask')).toHaveLength(1);
	});

	it('a detail of a new event that turns out to move one on the calendar is kept on its own', async () => {
		// The game of Sunday 25 at 10:00 written as Saturday 24 at 10:00: one of the days is wrong,
		// so the suggestion moves the game and keeps no notes; the shin pads become a task.
		const c = caseNamed('A club email moves the fixture the calendar has (sim)');
		const outcome = await read(c, {
			label: 'U13 game',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.event',
					title: 'U13 Eagles away game',
					date: { text: 'Saturday 24.10', numeric: '24.10', weekday: 6 },
					time: '10:00',
					timeText: '10:00',
					quote: 'the fixture for U13 on Saturday 24.10',
				},
				{
					kind: 'lists.task',
					title: 'Bring shin pads and the club shirt',
					of: 0,
					relation: 'bring',
					quote: 'Please bring shin pads and the club shirt.',
				},
			],
		});
		expect(outcome.drafts.map((d) => d.actionId).toSorted()).toEqual([
			'calendar.changeEvent',
			'lists.addTask',
		]);
		expect(harmfulChecks(outcome)).toEqual([]);
	});

	it('a detail of an event that is already there is kept on its own', async () => {
		const c: Case = {
			...caseNamed(RECITAL),
			seed: [
				{
					action: 'calendar.createEvent',
					input: { title: 'Piano recital', date: '2026-11-14', startTime: '15:00' },
				},
			],
		};
		const outcome = await read(c, {
			label: 'Piano recital',
			intent: 'actionable',
			mentions: [
				recitalEvent,
				{
					kind: 'lists.task',
					title: 'Bring blue music book',
					of: 0,
					quote: 'bring blue music book',
				},
			],
		});
		expect(outcome.drafts.map((d) => d.actionId)).toEqual(['lists.addTask']);
	});
});

describe('a moved fixture', () => {
	const c = caseNamed('A club email moves the fixture the calendar has (sim)');
	const change = (target: string) => ({
		label: 'Fixture moved',
		intent: 'actionable',
		mentions: [
			{
				kind: 'calendar.eventChange',
				target,
				date: { text: 'Saturday 24.10', numeric: '24.10', weekday: 6 },
				time: '11:00',
				timeText: '11:00',
				place: 'Stadion Bežigrad',
				quote: 'the fixture for U13 on Saturday 24.10 is moved to 11:00 at Stadion Bežigrad',
			},
		],
	});

	it('changes the game on the calendar when it is named as the calendar names it', async () => {
		const outcome = await read(c, change('U13 Eagles away game'));
		expect(failedChecks(outcome)).toEqual([]);
		const [moved] = outcome.drafts;
		expect(moved).toMatchObject({
			actionId: 'calendar.changeEvent',
			input: { date: '2026-10-24', startTime: '11:00', location: 'Stadion Bežigrad' },
		});
		expect(moved?.uncertainFields).not.toContain('id');
	});

	it('changes the game named by its code alone, marked for a look', async () => {
		const outcome = await read(c, change('fixture for U13'));
		expect(failedChecks(outcome)).toEqual([]);
		const [moved] = outcome.drafts;
		expect(moved?.actionId).toBe('calendar.changeEvent');
		expect(moved?.uncertainFields).toContain('id');
	});

	it('read as a new event, the card says the game may be there already', async () => {
		const outcome = await read(c, {
			...change('x'),
			mentions: [
				{
					kind: 'calendar.event',
					title: 'U13 fixture',
					date: { text: 'Saturday 24.10', numeric: '24.10', weekday: 6 },
					time: '11:00',
					timeText: '11:00',
					quote: 'the fixture for U13 on Saturday 24.10 is moved to 11:00',
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
		expect(outcome.drafts[0]).toMatchObject({ actionId: 'calendar.createEvent', mayExist: true });
	});
});
