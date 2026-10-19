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
					detailOf: 0,
					quote: 'no phones in the hall',
				},
				{
					kind: 'lists.task',
					title: 'Bring blue music book',
					detailOf: 0,
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
						detailOf: 0,
						quote: 'Bring white shirt, shin pads & water',
					},
					{
						kind: 'lists.task',
						title: 'Pay 10 EUR for the bus',
						date: { text: 'Fri', weekday: 5 },
						detailOf: 0,
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
					detailOf: 0,
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
					detailOf: 0,
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

describe("the free models' answers, replayed", () => {
	// Their exact answers in the full run of the eval: each case's checks hold.
	it.each([
		[
			'the recital, with the rule and the book in the notes (120b)',
			'A recital: the rule and what to bring are its notes (sim)',
			{
				label: 'Piano recital',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.event',
						title: 'Piano recital',
						date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
						time: '15:00',
						timeText: '15:00',
						place: 'Music school',
						notes: 'Practise every day. No phones in the hall. Bring blue music book.',
						quote:
							'piano recital Sat 14 Nov 15:00 music school, practise every day pls. no phones in the hall. bring blue music book',
					},
				],
			},
		],
		[
			'the coach message, the fee a task of its own (120b)',
			'A coach message: the game, what to bring, the bus fee (sim)',
			{
				label: 'U13 Eagles away game',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.event',
						title: 'U13 Eagles away game',
						date: { text: 'Sun 25.10', day: 25, month: 10, weekday: 7 },
						time: '10:00',
						timeText: '10:00',
						place: 'Olimpija Park',
						notes: 'Meet 08:30 at the club. Bring white shirt, shin pads & water.',
						quote:
							'U13 Eagles away game Sun 25.10 KO 10:00 at Olimpija Park, meet 08:30 at the club. Bring white shirt, shin pads & water.',
					},
					{
						kind: 'lists.task',
						title: 'Pay for the bus',
						date: { text: 'Fri', weekday: 5 },
						notes: '10 EUR',
						quote: 'Pay 10 EUR for the bus by Fri thx Coach Jure',
					},
				],
			},
		],
		[
			'the club email, a change of the game on the calendar (120b)',
			'A club email moves the fixture the calendar has (sim)',
			{
				label: 'U13 fixture change',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.eventChange',
						target: 'U13 Eagles away game',
						date: { text: 'Saturday 24.10', day: 24, month: 10, weekday: 6 },
						time: '11:00',
						timeText: '11:00',
						place: 'Stadion Bežigrad',
						quote:
							'the fixture for U13 on Saturday 24.10 is moved to 11:00 at Stadion Bežigrad (was 10:00 at Olimpija)',
					},
					{
						kind: 'lists.task',
						title: 'Bring shin pads',
						forMe: false,
						quote: 'Please bring shin pads and the club shirt.',
					},
					{
						kind: 'lists.task',
						title: 'Bring the club shirt',
						forMe: false,
						quote: 'Please bring shin pads and the club shirt.',
					},
					{
						kind: 'lists.task',
						title: "Take Ivy's team kit bag to the club room",
						forMe: false,
						quote: "Ivy's team kit bag to the club room.",
					},
				],
				addressed: [],
			},
		],
		[
			'the club email, a change of the game on the calendar (vl)',
			'A club email moves the fixture the calendar has (sim)',
			{
				label: 'U13 fixture moved',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.eventChange',
						target: 'U13 Eagles away game',
						date: { text: 'Saturday 24.10', day: 24, month: 10, year: 2026 },
						time: '11:00',
						timeText: '11:00',
						place: 'Stadion Bežigrad',
						quote: 'the fixture for U13 on Saturday 24.10 is moved to 11:00 at Stadion Bežigrad',
					},
					{
						kind: 'lists.task',
						title: 'Bring shin pads and the club shirt',
						people: ['Ivy'],
						quote: 'Please bring shin pads and the club shirt',
					},
					{
						kind: 'lists.task',
						title: "Take Ivy's team kit bag to the club room",
						people: ['Ivy'],
						quote: "Ivy's team kit bag to the club room",
					},
				],
			},
		],
		[
			'the cancellation of the moved piano lesson (120b)',
			'A cancellation of a moved lesson takes the moved one (sim fixture)',
			{
				label: 'Piano lesson cancelled',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.eventCancel',
						target: 'Piano lesson',
						date: { text: 'Friday 16 Oct', day: 16, month: 10, weekday: 5 },
						quote: 'Piano on Friday 16 Oct is cancelled, the teacher is ill',
					},
				],
			},
		],
		[
			'the cancellation of the moved piano lesson (vl)',
			'A cancellation of a moved lesson takes the moved one (sim fixture)',
			{
				label: 'Piano lesson cancelled',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.eventCancel',
						target: 'Piano lesson',
						date: { text: 'Friday 16 Oct', day: 16, month: 10, weekday: 5 },
						quote: 'Piano on Friday 16 Oct is cancelled',
					},
				],
			},
		],
		[
			'a swim lesson cancelled, named by the model for Ivy alone (vl)',
			'A cancellation that fits two swim lessons is not acted on (sim fixture)',
			{
				label: 'Swim lesson cancelled',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.eventCancel',
						target: 'Swim lesson Ivy',
						date: { text: 'this Saturday', weekday: 6 },
						quote: 'swim lesson is cancelled this Saturday',
					},
				],
			},
		],
	] as const)('%s', async (_label, name, answer) => {
		const outcome = await read(caseNamed(name), answer);
		expect(failedChecks(outcome)).toEqual([]);
	});
});

describe('who an event is for, written into its title', () => {
	// As 120b read it in two of three runs: the name in the title, nobody in people (the answer
	// as the drafts of those runs show it; the run kept only their drafts).
	it('takes the one member the title and the message name, marked for a look', async () => {
		const outcome = await read(caseNamed('Exact date with year (Turkish)'), {
			label: 'Aşı randevusu',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.event',
					title: 'Deniz vaccination appointment',
					date: { text: '3 Kasım 2026', day: 3, month: 11, year: 2026, weekday: 2 },
					time: '10:15',
					timeText: '10:15',
					place: 'Şehitkamil Aile Sağlığı Merkezi',
					quote: 'Deniz’in aşı randevusu 3 Kasım 2026 Salı saat 10:15',
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
		expect(outcome.drafts[0]?.uncertainFields).toContain('memberIds');
	});

	it('takes nobody when the title names a member the message does not', async () => {
		const answer = (title: string) => ({
			label: 'Aşı randevusu',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.event',
					title,
					date: { text: '3 Kasım 2026', day: 3, month: 11, year: 2026, weekday: 2 },
					time: '10:15',
					timeText: '10:15',
					quote: 'Deniz’in aşı randevusu 3 Kasım 2026 Salı saat 10:15',
				},
			],
		});
		const c = caseNamed('Exact date with year (Turkish)');
		for (const title of ['Mehmet vaccination appointment']) {
			const outcome = await read(c, answer(title));
			expect(outcome.drafts[0]?.input.memberIds, title).toEqual([]);
		}
	});
});

describe('readings the free models gave after the detail link came in', () => {
	it('a meal whose day is only in the words it rests on is planned for that day, marked', async () => {
		// 120b's exact answer: the fish pie has no date, its quote says Friday.
		const outcome = await read(caseNamed('Meals planned for the week (English)'), {
			label: 'Meal plan',
			intent: 'actionable',
			mentions: [
				{
					kind: 'kitchen.meal',
					title: 'Tacos',
					date: { text: 'Wednesday', weekday: 3 },
					quote: 'tacos on Wednesday',
				},
				{
					kind: 'kitchen.meal',
					title: 'Fish pie',
					variant: 'dinner',
					quote: 'fish pie for dinner on Friday',
					detailOf: 1,
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
		const pie = outcome.drafts.find((d) => d.input.title === 'Fish pie');
		expect(pie?.uncertainFields).toContain('date');
	});

	it('a garage invoice keeps no amount of money in the log notes', async () => {
		// 120b's exact answer: the total copied into the notes.
		const outcome = await read(caseNamed('A garage invoice for a listed car (English)'), {
			label: 'Corolla service',
			intent: 'actionable',
			mentions: [
				{
					kind: 'vehicles.log',
					about: 'Corolla',
					date: { text: '3 October 2026', day: 3, month: 10, year: 2026, weekday: 6 },
					place: 'Northside Garage',
					notes: 'Mileage 62,300 km. Total 189.00',
					quote:
						'Northside Garage - invoice 3 October 2026. Corolla: annual service, oil and filter, new wiper blades. Mileage 62,300 km. Total 189.00',
				},
			],
		});
		expect(harmfulChecks(outcome)).toEqual([]);
		expect(outcome.drafts[0]?.input.notes).toBe('Mileage 62,300 km.');
	});
});
