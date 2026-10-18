import { describe, expect, it } from 'vitest';
import { CASES, type Draft } from '../eval/cases.ts';
import { failedChecks, harmfulChecks, runCaseOn } from '../eval/household.ts';

/**
 * The cases written from the simulation have no recorded answers yet, so these read each with the
 * answer a careful model gives (the fake model) and hold the household fixture, the checks and
 * the way a failed check is classed to it: the code is right when the model is.
 */

const caseNamed = (name: string) => {
	const found = CASES.find((c) => c.name === name);
	if (!found) throw new Error(`no case named ${name}`);
	return found;
};
const read = (name: string, answer: unknown) =>
	runCaseOn(caseNamed(name), {
		prepare(k) {
			k.llm.respond(answer);
		},
	});
const day = (text: string, dayOfMonth: number, month: number, weekday: number, year?: number) => ({
	text,
	day: dayOfMonth,
	month,
	weekday,
	...(year && { year }),
});

describe('the household the simulation cases start from', () => {
	it('holds similar lessons, class codes, car plates, a moved lesson and two shopping lists', async () => {
		const outcome = await read('A child: a ball for the dog is shopping (sim)', {
			label: 'A ball',
			intent: 'actionable',
			mentions: [{ kind: 'lists.shoppingItem', title: 'Ball', quote: 'a ball for biscuit' }],
		});
		expect(outcome.status).toBe('extracted');
		expect(failedChecks(outcome)).toEqual([]);
	});
});

describe('the simulation cases, read by a model that gets them right', () => {
	it('the coach message: shopping, and the cancellation shown only as a guess', async () => {
		const outcome = await read('A child: no training on another day, ice cream and a ball (sim)', {
			label: 'Shopping',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.eventCancel',
					target: 'Football training',
					date: { text: 'thurs', weekday: 4 },
					quote: 'no training thurs bc of rain',
				},
				{ kind: 'lists.shoppingItem', title: 'Ice cream', quote: 'ice cream' },
				{ kind: 'lists.shoppingItem', title: 'Football', quote: 'a new football' },
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
	});

	it('the school email about class 1B changes the trip of 1B, not 4B', async () => {
		const outcome = await read('A school email changes the time of the trip of class 1B (sim)', {
			label: 'Trip to Bled',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.eventChange',
					target: 'Class 1B trip',
					date: day('Friday 30 October', 30, 10, 5),
					time: '07:40',
					timeText: '07:40',
					quote: 'We meet at school at 07:40 now, not 08:10.',
				},
				{
					kind: 'lists.task',
					title: 'Return the signed permission slip',
					date: day('Monday 26 October', 26, 10, 1),
					quote: 'return the signed permission slip by Monday 26 October',
				},
				{
					kind: 'lists.task',
					title: 'Pay the 25 EUR bus fee',
					date: day('Monday 26 October', 26, 10, 1),
					quote: 'pay the 25 EUR bus fee in the school app',
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
	});

	it('a letter that names nobody has Who marked as "check this"', async () => {
		const outcome = await read('A letter that names nobody marks Who as "check this" (sim)', {
			label: 'Year 8 evening',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.event',
					title: 'Year 8 options evening',
					date: day('Thursday 12 November', 12, 11, 4),
					time: '17:30',
					timeText: '17:30',
					place: 'Main hall',
					quote: 'the Year 8 options evening is on Thursday 12 November at 17:30 in the main hall',
				},
				{
					kind: 'lists.task',
					title: 'Return the reply slip',
					date: day('Friday 30 October', 30, 10, 5),
					quote: 'return the reply slip by Friday 30 October',
				},
				{
					kind: 'lists.task',
					title: 'Bring the football kit for the photo session',
					date: day('Wednesday 28 October', 28, 10, 3),
					quote: 'bring her football kit to change for the photo session on Wednesday 28 October',
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
	});

	it('the move of Ivy’s swim lesson reaches her lesson and not the lesson of Tom', async () => {
		const outcome = await read('A move names the swim lesson of Ivy, not Tom (sim fixture)', {
			label: 'Swim lesson moved',
			intent: 'actionable',
			mentions: [
				{
					kind: 'calendar.eventChange',
					target: 'Swim lesson Ivy',
					date: day('Saturday 17 Oct', 17, 10, 6),
					time: '11:00',
					timeText: '11:00',
					quote: "Ivy's swim lesson on Saturday 17 Oct is moved to 11:00",
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
	});

	it('a cancellation that fits both swim lessons is not acted on', async () => {
		const outcome = await read(
			'A cancellation that fits two swim lessons is not acted on (sim fixture)',
			{
				label: 'Swim cancelled',
				intent: 'actionable',
				mentions: [
					{
						kind: 'calendar.eventCancel',
						target: 'Swim lesson',
						date: day('this Saturday', 10, 10, 6),
						quote: 'swim lesson is cancelled this Saturday',
					},
				],
			},
		);
		expect(failedChecks(outcome)).toEqual([]);
	});

	it('the car is told by its plate', async () => {
		const outcome = await read('An invoice names a car by its plate (sim fixture)', {
			label: 'Golf brakes',
			intent: 'actionable',
			mentions: [
				{
					kind: 'vehicles.log',
					about: 'Golf',
					date: day('2 October 2026', 2, 10, 5, 2026),
					place: 'Northside Garage',
					notes: 'New brake pads front. Mileage 48,200 km',
					quote: 'Vehicle LJ CD-456: new brake pads front',
				},
			],
		});
		expect(failedChecks(outcome)).toEqual([]);
	});

	it('an item is ticked off on the list it is on', async () => {
		const outcome = await read(
			'Ticking off an item names the right one of two lists (sim fixture)',
			{
				label: 'Batteries bought',
				intent: 'actionable',
				mentions: [
					{
						kind: 'lists.bought',
						target: 'Batteries',
						place: 'Hardware store',
						quote: 'Got the batteries already',
					},
				],
			},
		);
		expect(failedChecks(outcome)).toEqual([]);
	});
});

describe('missed and harmful', () => {
	const draft = (actionId: string, input: Draft['input'], extra: Partial<Draft> = {}): Draft => ({
		actionId,
		input,
		uncertainFields: [],
		mayExist: false,
		...extra,
	});
	const outcomeOf = async (name: string, drafts: Draft[]) => {
		const c = caseNamed(name);
		const results = c.checks.map((check) => {
			const ok = check.pass(drafts, {}, { summary: 'x', kind: 'actionable' }, c.text, {});
			return {
				check,
				ok,
				failure: ok
					? null
					: (check.failure?.(drafts, {}, { summary: 'x', kind: 'actionable' }, c.text, {}) ??
						'missed'),
			};
		});
		return { status: 'extracted', results } as Parameters<typeof harmfulChecks>[0];
	};

	it('a wanted draft that is not there at all is missed', async () => {
		const outcome = await outcomeOf('A child: bins tonight is a task for today (sim)', []);
		expect(failedChecks(outcome).length).toBeGreaterThan(0);
		expect(harmfulChecks(outcome)).toEqual([]);
	});

	it('a wanted draft with a wrong day that looks certain is harmful', async () => {
		const outcome = await outcomeOf('A child: bins tonight is a task for today (sim)', [
			draft('lists.addTask', { title: 'Bins', dueDate: '2026-10-07' }),
		]);
		expect(harmfulChecks(outcome)).toEqual(['lists.addTask: the bins, due today']);
	});

	it('the same wrong day shown as "check this" is only missed', async () => {
		const outcome = await outcomeOf('A child: bins tonight is a task for today (sim)', [
			draft(
				'lists.addTask',
				{ title: 'Bins', dueDate: '2026-10-07' },
				{ uncertainFields: ['dueDate'] },
			),
		]);
		expect(failedChecks(outcome).length).toBeGreaterThan(0);
		expect(harmfulChecks(outcome)).toEqual([]);
	});

	it('something proposed that must not be is harmful, unless it is shown as unsure', async () => {
		const name = 'A cancellation that fits two swim lessons is not acted on (sim fixture)';
		const acted = await outcomeOf(name, [draft('calendar.deleteEvent', { id: 'cal_event_1' })]);
		expect(harmfulChecks(acted)).toEqual(['no calendar.deleteEvent']);
		const asked = await outcomeOf(name, [
			draft('calendar.deleteEvent', { id: 'cal_event_1' }, { uncertainFields: ['id'] }),
		]);
		expect(failedChecks(asked)).toEqual(['no calendar.deleteEvent']);
		expect(harmfulChecks(asked)).toEqual([]);
	});

	it('a guess shown as certain is harmful, a missing card only missed', async () => {
		const name = 'A letter that names nobody marks Who as "check this" (sim)';
		const certain = await outcomeOf(name, [
			draft('calendar.createEvent', { date: '2026-11-12', startTime: '17:30', memberIds: [] }),
		]);
		expect(harmfulChecks(certain)).toEqual([
			'calendar.createEvent: the options evening (nobody named) is "check this" on memberIds',
		]);
		const absent = await outcomeOf(name, []);
		expect(harmfulChecks(absent)).toEqual([]);
	});
});
