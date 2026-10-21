import type { Outcome } from './checks.ts';
import {
	about,
	answeredWithCards,
	atMost,
	type Check,
	drafted,
	either,
	itemTitles,
	lastTurn,
	looked,
	neverSays,
	noDraft,
	noDrafts,
	occurrenceOn,
	on,
	says,
	shortLead,
} from './checks.ts';
import type { Case, Person, SeedEvent, SeedItem, SeedTask } from './seed.ts';

/**
 * Assistant evaluation cases. Each comes from a mistake the assistant made in use, with the
 * person's own words. "Today" is Tuesday 6 October 2026, 10:00 (Europe/Amsterdam, English) unless
 * a case says otherwise; this week runs Monday 5 to Sunday 11 October. The household is Sofia and
 * Lukas (admins) with Ellie (14) and Noah (9); Sofia asks unless a case says who. Every case is
 * also checked for Markdown bold, raw handles or ids, ISO dates and wrong weekdays in the answer, and
 * for claiming a suggestion when there is none. A question case says how it should be read
 * (`expect`) and is held to its answer card: every fact of those days shown and nothing outside
 * them. The round-5 cases run in the Novak household on a Sunday (see `novak`). Add a case for every
 * assistant mistake found in use.
 */

/** The family calendar most cases share. */
const CALENDAR: SeedEvent[] = [
	{
		title: 'Sunday planning',
		date: '2026-09-06',
		startTime: '19:30',
		endTime: '20:00',
		recurrence: { freq: 'weekly', interval: 1, byDay: ['SU'] },
	},
	{
		title: 'Swim training',
		date: '2026-09-01',
		startTime: '18:00',
		endTime: '19:30',
		who: ['Ellie'],
		location: 'City pool',
		recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
	},
	{ title: 'Swimming', date: '2026-10-08', startTime: '17:00', endTime: '18:00', who: ['Noah'] },
	{
		title: 'Swimming gala',
		date: '2026-10-17',
		startTime: '09:00',
		endTime: '13:00',
		who: ['Ellie'],
	},
	{ title: 'Dentist checkup', date: '2026-10-08', startTime: '09:30', who: ['Noah'] },
	{
		title: 'Early shift',
		date: '2026-10-07',
		startTime: '06:45',
		endTime: '15:15',
		who: ['Lukas'],
	},
	{ title: 'Client meeting', date: '2026-10-07', startTime: '11:00', who: ['Sofia'] },
	{
		title: 'Piano lesson',
		date: '2026-09-02',
		startTime: '16:00',
		endTime: '16:45',
		who: ['Ellie'],
		recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
	},
	{ title: 'Football training', date: '2026-10-07', startTime: '17:00', who: ['Noah'] },
	{
		title: 'Work dinner',
		date: '2026-10-07',
		startTime: '19:30',
		endTime: '21:30',
		who: ['Lukas'],
	},
];

const GROCERIES: SeedItem[] = [
	{ title: 'Bread' },
	{ title: 'Cheddar', quantity: '200 g' },
	{ title: 'Tomatoes', quantity: '6' },
	{ title: 'Pasta' },
	{ title: 'Eggs', quantity: '10' },
];

/** A long list, so the item asked about is one row among many. */
const LONG_GROCERIES: SeedItem[] = [
	...[
		'Apples',
		'Pears',
		'Grapes',
		'Lemons',
		'Limes',
		'Oranges',
		'Carrots',
		'Onions',
		'Garlic',
		'Potatoes',
		'Leeks',
		'Spinach',
		'Lettuce',
		'Cucumber',
		'Peppers',
		'Courgette',
		'Mushrooms',
		'Broccoli',
		'Cauliflower',
		'Sweetcorn',
		'Rice',
		'Couscous',
		'Lentils',
		'Chickpeas',
		'Flour',
		'Sugar',
		'Salt',
		'Black pepper',
		'Olive oil',
		'Vinegar',
		'Butter',
		'Yoghurt',
		'Cream',
		'Mozzarella',
		'Parmesan',
		'Feta',
		'Ham',
		'Chicken breast',
		'Minced beef',
		'Salmon',
		'Tuna',
		'Sourdough',
		'Wraps',
		'Crackers',
		'Oats',
		'Muesli',
		'Honey',
		'Jam',
		'Peanut butter',
		'Coffee',
		'Tea',
		'Orange juice',
		'Sparkling water',
		'Crisps',
		'Chocolate',
		'Biscuits',
		'Ice cream',
		'Frozen peas',
		'Dishwasher tablets',
		'Bin bags',
		'Toilet paper',
		'Washing powder',
	].map((title) => ({ title })),
	{ title: 'Bananas for pancakes' },
	{ title: 'Kitchen roll' },
];

const CHANGE = 'calendar.changeEvent';
const TICK = 'lists.checkShoppingItem';

/** A refusal in words: the answer says the thing is not there. */
const NOT_THERE = /\b(no|not|isn't|couldn't|can't|cannot|don't|didn't|doesn't)\b/i;

/** In the last turn, no change of the whole series (a change without `occurrence`). */
const noSeriesChange: Check = {
	label: 'no change of the whole series in the last turn',
	pass: (o) => !lastTurn(o).drafts.some((d) => d.actionId === CHANGE && !d.input.occurrence),
};

/** One date of a repeating event moved to `time`. */
const movesOne = (title: string, date: string, time: string) =>
	drafted(
		CHANGE,
		`${title} on ${date} to ${time}`,
		(i, o) => on(title)(i, o) && occurrenceOn(i, date, o.timeZone) && i.startTime === time,
	);

/** A draft that sets a reminder or a task for `date` (and `time`, when given). */
const remindsOn = (date: string, time?: string): Check => ({
	label: `drafted a reminder or task on ${date}${time ? ` at ${time}` : ''}`,
	pass: (o: Outcome) =>
		lastTurn(o).drafts.some((d) => {
			if (d.actionId === 'calendar.createEvent')
				return d.input.date === date && (time === undefined || d.input.startTime === time);
			if (d.actionId === 'lists.addTask')
				return d.input.dueDate === date && (time === undefined || d.input.dueTime === time);
			return false;
		}),
});

/** The calendar with the family's tags on some of its events. */
const EVENT_TAGS: Record<string, string[]> = {
	'Football training': ['football'],
	'Swim training': ['sports'],
	'Dentist checkup': ['health'],
};
const TAGGED_CALENDAR: SeedEvent[] = CALENDAR.map((event) =>
	EVENT_TAGS[event.title] ? { ...event, tags: EVENT_TAGS[event.title] } : event,
);
const FAMILY_TAGS = Object.values(EVENT_TAGS).flat();

/** Ellie's open tasks: none is due on the weekend of 10 and 11 October. */
const ELLIE_TASKS: SeedTask[] = [
	{ title: 'Pack the swim bag', dueDate: '2026-10-08', who: 'Ellie' },
	{ title: 'Fractions worksheet', dueDate: '2026-10-13', who: 'Ellie' },
	{ title: 'Return the library books', dueDate: '2026-10-16', who: 'Ellie' },
];
/** An answer that says nothing falls in the span. */
const NOTHING = /\b(nothing|no tasks?|none)\b/i;
/** An answer that says nothing is due in the span, which leaves room for open tasks due later. */
const DUE = /\bnothing (?:is )?due\b/i;
/** Words that put what is listed outside the span asked about. */
const OUTSIDE =
	/\bnext:|\b(outside|after the weekend|later|beyond|next week|before the weekend|other days|not (?:due )?(?:this|on the|at the) weekend)\b/i;

/**
 * The household of the round-5 cases: Mara and Tom (admins) with Ivy (14) and Leo (6). It is
 * Sunday 18 October 2026, 10:00 in Ljubljana, and the region's week starts on Monday, so "this
 * week" asked today is the coming one.
 */
const NOVAK_FAMILY: Person[] = [
	{ name: 'Mara', roleId: 'admin', about: 'Mother, teacher' },
	{ name: 'Tom', roleId: 'admin', about: 'Father, works shifts' },
	{ name: 'Ivy', roleId: 'supervised', about: '14, plays football and the piano' },
	{ name: 'Leo', roleId: 'supervised', about: '6 years old' },
];

const NOVAK_WEEK: SeedEvent[] = [
	{ title: "Parents' evening", date: '2026-10-20', startTime: '18:00', who: ['Mara', 'Tom'] },
	{ title: 'Football training', date: '2026-10-21', startTime: '17:00', who: ['Ivy'] },
	{
		title: 'Swimming lesson',
		date: '2026-10-22',
		startTime: '16:30',
		endTime: '17:30',
		who: ['Leo'],
		notes: 'Pick up from the pool at 17:30',
	},
	{ title: 'Piano lesson', date: '2026-10-22', startTime: '18:00', who: ['Ivy'] },
	{
		title: "Dinner at Nona Marija's",
		date: '2026-10-23',
		startTime: '18:30',
		endTime: '21:00',
	},
	{
		title: 'U13 match',
		date: '2026-10-24',
		startTime: '10:00',
		who: ['Ivy'],
		location: 'Olimpija',
		notes: 'Bring white shirt, shin pads & water',
	},
	{ title: 'Date night', date: '2026-10-31', startTime: '19:00', who: ['Mara', 'Tom'] },
];

const NOVAK_TASKS: SeedTask[] = [
	{ title: 'Sign the school trip form', dueDate: '2026-10-20', who: 'Mara' },
	{ title: 'Practise reading', dueDate: '2026-10-19', who: 'Leo' },
];

/** A case in the Novak household, on Sunday 18 October unless it says another day. */
const novak = (c: Omit<Case, 'family' | 'timeZone' | 'formatLocale'>): Case => ({
	family: NOVAK_FAMILY,
	timeZone: 'Europe/Ljubljana',
	formatLocale: 'sl-SI',
	today: '2026-10-18',
	events: NOVAK_WEEK,
	tasks: NOVAK_TASKS,
	...c,
});

export const CASES: Case[] = [
	// Not the closest item: a name that is not there is refused, not mapped to a similar one.
	{
		name: 'not there: "Dental cleaning" when only "Dentist checkup" exists',
		events: CALENDAR,
		asks: ['Change Dental cleaning to 10:00'],
		checks: [noDrafts(), says(NOT_THERE)],
	},
	{
		name: 'not there: anchovies on no list',
		shopping: { Groceries: GROCERIES, Pharmacy: [{ title: 'Plasters' }] },
		asks: ['Remove the anchovies from the shopping list'],
		checks: [noDrafts(), says(/anchov/i, NOT_THERE)],
	},

	// One date of a repeating event.
	{
		name: 'one date: Sunday planning on 25 October only',
		events: CALENDAR,
		asks: ['Move only the Sunday planning on 25 October to 18:00'],
		checks: [movesOne('Sunday planning', '2026-10-25', '18:00'), noSeriesChange],
	},
	{
		name: 'one date: follow-up "Only this Sunday"',
		events: CALENDAR,
		asks: ['Move Sunday planning to 18:00', 'Only this Sunday, please.'],
		checks: [movesOne('Sunday planning', '2026-10-11', '18:00'), noSeriesChange],
	},

	// A change after a question: the record the card showed is the one "it" means.
	{
		name: 'follow-up: "move it" after a question moves the record the card showed',
		events: CALENDAR,
		asks: ['When is the dentist on Thursday?', 'Yes, move it to 10:00 please.'],
		checks: [
			drafted(
				CHANGE,
				'Dentist checkup to 10:00',
				(i, o) => on('Dentist checkup')(i, o) && i.startTime === '10:00',
			),
			noDraft('that adds a second dentist event', (d) => d.actionId === 'calendar.createEvent'),
		],
	},

	// Ticking off.
	{
		name: 'tick off: "the bananas" on a long list',
		as: 'Lukas',
		shopping: { Groceries: LONG_GROCERIES },
		asks: ['Tick off the bananas'],
		checks: [
			drafted(
				TICK,
				'Bananas for pancakes',
				(i, o) => on('Bananas for pancakes')(i, o) && i.done !== false,
			),
		],
	},
	{
		name: 'tick off: milk already bought, oat milk open',
		shopping: {
			Groceries: [{ title: 'Oat milk' }, { title: 'Milk', bought: true }, ...GROCERIES],
		},
		asks: ['Tick off the milk and the oat milk'],
		checks: [
			drafted(TICK, 'Oat milk', on('Oat milk')),
			atMost(1, 'on Oat milk', about('Oat milk')),
			noDraft(
				'on Oat milk for "milk"',
				(d, o) =>
					about('Oat milk')(d, o) && /^\s*(the )?milk\s*$/i.test(String(d.input.label ?? '')),
			),
		],
	},

	// Finding events.
	{
		name: 'find: swimming this week',
		as: 'Lukas',
		events: CALENDAR,
		asks: ['When is the swimming this week?'],
		expect: { from: '2026-10-06', to: '2026-10-11', topics: ['calendar'] },
		checks: [
			looked('calendar.findEvents', 'calendar.digest'),
			says(/swim training/i, /tue/i, /thu/i),
		],
	},
	{
		name: "find: Lukas's Wednesday",
		as: 'Lukas',
		events: CALENDAR,
		asks: ["What's on my calendar on Wednesday?"],
		expect: { from: '2026-10-07', to: '2026-10-07', topics: ['calendar'], people: ['Lukas'] },
		checks: [says(/early shift/i, /work dinner/i), neverSays(/piano lesson/i)],
	},

	// A search by the person's words finds nothing, but the day holds the thing under other words.
	{
		name: 'find: "pick up Noah on Thursday" is the swimming lesson (known failure: "no event, no pick-up")',
		events: CALENDAR,
		asks: ['Do we need to pick Noah up anywhere on Thursday?'],
		expect: { from: '2026-10-08', to: '2026-10-08', topics: ['calendar'], people: ['Noah'] },
		checks: [
			says(/swimming/i, /17:00|5(?::00)? ?pm/i),
			neverSays(/\b(no events?|nothing)\b.*\bthursday\b/is),
		],
	},

	// An empty meal plan is not an empty evening: a dinner elsewhere is on the calendar.
	{
		name: "dinner: nothing in the meal plan, a dinner at Nona Marija's on the calendar",
		events: [
			{
				title: "Dinner at Nona Marija's",
				date: '2026-10-09',
				startTime: '18:30',
				endTime: '21:00',
			},
		],
		asks: ['What is for dinner on Friday?'],
		expect: { from: '2026-10-09', to: '2026-10-09', topics: ['meals'] },
		checks: [looked('kitchen.mealPlan', 'kitchen.digest'), says(/nona marija/i)],
	},

	// A reminder is only a suggestion until a person approves it.
	{
		name: 'reminder: "Remind me to pack the football kit" is suggested, not created',
		as: 'Lukas',
		asks: ['Remind me on Thursday to pack the football kit'],
		checks: [
			remindsOn('2026-10-08'),
			neverSays(
				/\b(?:I(?:'ve| have)?|we(?:'ve| have)?) (?:created|added|set|scheduled)\b/i,
				/\b(?:has|have) been (?:created|added|scheduled)\b/i,
			),
		],
	},

	// The suggestion's words keep its day.
	{
		name: 'reminder: the suggestion says the day it is for',
		as: 'Lukas',
		asks: ['Add a task: Pack my football kit on Thursday'],
		checks: [remindsOn('2026-10-08'), says(/Thursday,? (?:8 October|October 8)/i)],
	},

	// A message with a question and a request answers both: a card for the question and a
	// suggestion for the request, in one reply.
	novak({
		name: 'question and request: "Do I have anything on Thursday? I also want to remember to pack my football kit"',
		as: 'Ivy',
		asks: ['Do I have anything on Thursday? I also want to remember to pack my football kit'],
		expect: { from: '2026-10-22', to: '2026-10-22', topics: ['calendar'], people: ['Ivy'] },
		checks: [
			{
				label: 'suggested a task or event about the football kit',
				pass: (o) => lastTurn(o).drafts.some((d) => /kit/i.test(JSON.stringify(d.input))),
			},
			says(/kit/i),
		],
	}),
	// The same, the request first.
	{
		name: 'request and question: "Add milk and what is for dinner tonight?"',
		as: 'Lukas',
		asks: ['Add milk and what is for dinner tonight?'],
		expect: { from: '2026-10-06', to: '2026-10-06', topics: ['meals'] },
		checks: [
			drafted('lists.addShoppingItems', 'milk', (i) => /milk/i.test(itemTitles(i).join(' '))),
		],
	},
	// Two questions about different days are two cards.
	{
		name: 'two questions: "What is on Thursday? And what is on Saturday?" get a card each',
		as: 'Sofia',
		events: CALENDAR,
		asks: ['What is on Thursday? And what is on Saturday?'],
		checks: [
			answeredWithCards(
				{ from: '2026-10-08', to: '2026-10-08' },
				{ from: '2026-10-10', to: '2026-10-10' },
			),
			noDrafts(),
		],
	},

	// Weekdays.
	{
		name: 'weekday: 20 October is a Tuesday (known failure: the model takes the weekday it was given)',
		events: CALENDAR,
		asks: ['Is there swimming on Wednesday 20 October?'],
		checks: [says(/tuesday/i)],
	},

	// Duplicates.
	{
		name: 'duplicate: a present for Mila is already a task',
		tasks: ['Buy a birthday present for Mila', 'Book the car service'],
		asks: ['Add a task to buy a present for Mila'],
		checks: [
			either(
				drafted('lists.addTask', 'marked "may already be there"', (_i, _o, d) => d.mayExist),
				says(/already|birthday present/i),
			),
		],
	},
	{
		name: 'duplicate: sandpaper is already on the Hardware store list',
		as: 'Lukas',
		shopping: {
			Groceries: GROCERIES,
			'Hardware store': [
				{ title: 'Sandpaper', quantity: '2 sheets' },
				{ title: 'Picture hooks' },
				{ title: 'Wood glue' },
			],
		},
		asks: ['Add sandpaper to the Hardware store list'],
		checks: [
			either(
				drafted(
					'lists.addShoppingItems',
					'marked "may already be there"',
					(_i, _o, d) => d.mayExist,
				),
				says(/already/i),
			),
		],
	},
	{
		name: 'remove: the cheddar is on the list (without naming the list)',
		shopping: { Groceries: GROCERIES, Pharmacy: [{ title: 'Plasters' }] },
		asks: ['take the cheddar off the shopping list, I dont like it'],
		checks: [
			{
				label: 'drafted the removal of Cheddar',
				pass: (o) =>
					lastTurn(o).drafts.some(
						(d) => /delete|remove/i.test(d.actionId) && about('Cheddar')(d, o),
					),
			},
		],
	},

	// Honesty: the calendar is off for the AI, so there is nothing to suggest with.
	{
		name: 'honesty: calendar off for the AI, asked to add an appointment',
		events: CALENDAR,
		areas: { calendar: 'off' },
		asks: ['Add a dentist appointment for Noah on Friday at 15:00'],
		// The calendar is closed to it, so nothing may land there; a task instead is fine as long
		// as the answer says what it suggested (the honesty check every case runs).
		checks: [noDraft('a calendar draft', (d) => d.actionId.startsWith('calendar.'))],
	},

	// Formatting: an overview invites lists and bold.
	{
		name: 'formatting: an overview of the week',
		events: CALENDAR,
		tasks: ['Buy a birthday present for Mila', 'Book the car service'],
		shopping: { Groceries: GROCERIES },
		asks: ["Give me an overview of this week: what's on, the open tasks and the shopping list."],
		expect: {
			from: '2026-10-06',
			to: '2026-10-11',
			topics: ['calendar', 'tasks', 'shopping'],
		},
		checks: [says(/sunday planning|swim/i, /mila/i)],
	},

	// A Turkish family asking in Turkish: the answer stays in Turkish.
	{
		name: 'Turkish: add milk and eggs',
		family: [
			{ name: 'Ayşe', roleId: 'admin' },
			{ name: 'Mehmet', roleId: 'admin' },
			{ name: 'Deniz', roleId: 'supervised', about: '9 yaşında' },
		],
		timeZone: 'Europe/Istanbul',
		locale: 'tr',
		shopping: { Market: [{ title: 'Ekmek' }, { title: 'Peynir' }] },
		asks: ['Alışveriş listesine süt ve yumurta ekler misin?'],
		checks: [
			drafted('lists.addShoppingItems', 'süt and yumurta', (i) => {
				const titles = itemTitles(i).join(' ');
				return /s[üu]t/i.test(titles) && /yumurta/i.test(titles);
			}),
			neverSays(/\b(the|you|your|added|suggested|list|will|milk|eggs)\b/i),
		],
	},

	// No area covers it: Home is not installed, so nothing about the flat can be looked up.
	{
		name: 'no area: the flat papers when Home is not installed',
		notInstalled: ['home'],
		tasks: [{ title: 'Book the car service', dueDate: '2026-10-20' }],
		asks: ['Where do we keep the flat papers, and what is due this month for the flat?'],
		checks: [
			noDrafts(),
			// The real answer promised what it never looked up, then asked for the flat's name.
			neverSays(/I can tell you what is due/i, /\?\s*$/),
			says(/\b(no|not|nothing|cannot|can't|don't)\b/i),
			// Later it read the empty notes as "no household obligations listed for the flat",
			// never saying that Home is not installed.
			says(/\bhome\b/i, /\bnot installed|isn't installed|is not installed|uninstalled\b/i),
		],
	},

	// A weekday the model works out itself: the date came from the tool, the weekday did not.
	{
		name: 'answer weekday: the bins on Tuesday 13 October',
		as: 'Noah',
		tasks: [{ title: 'Take out the bins', dueDate: '2026-10-13' }],
		asks: ['are the bins going out tonight? whats on for me this week'],
		checks: [
			// The real answer: "scheduled for Monday 20 October", a Tuesday.
			says(/tuesday,? 13 october|october 13/i),
			neverSays(/\b(monday|wednesday|thursday|friday|saturday|sunday),? 13 october/i),
		],
	},

	// Nothing in the span asked about: the answer says when the next one is.
	{
		name: 'span: nothing on this weekend, the next event is the Saturday after',
		events: [
			{ title: 'Dentist checkup', date: '2026-10-08', startTime: '09:30', who: ['Noah'] },
			{ title: 'Date night', date: '2026-10-17', startTime: '19:00', who: ['Sofia', 'Lukas'] },
		],
		asks: ["What's on this weekend?"],
		expect: { from: '2026-10-10', to: '2026-10-11', topics: ['calendar'] },
		checks: [says(/\b(nothing|no events?|none|free)\b/i, /date night/i, /17 october|october 17/i)],
	},

	// Nothing in the span asked about, and the other open tasks said to fall outside it.
	{
		name: 'span: nothing open for Ellie this weekend',
		as: 'Ellie',
		tasks: ELLIE_TASKS,
		asks: ['What is still open for me this weekend?'],
		expect: { from: '2026-10-10', to: '2026-10-11', topics: ['tasks'], people: ['Ellie'] },
		checks: [
			{
				// The real answer said "You have nothing open for you this weekend." and then listed
				// every open task under "Still open for you", as if they were the weekend's.
				label: 'says nothing falls this weekend, and marks the tasks it lists as outside it',
				pass: (o) => {
					const reply = lastTurn(o).reply;
					const lists = ELLIE_TASKS.some((t) =>
						reply.toLowerCase().includes(t.title.toLowerCase()),
					);
					// "Nothing is due this weekend" and then the open tasks with their dates is
					// consistent; "nothing open" and then the open tasks is not.
					return NOTHING.test(reply) && (!lists || OUTSIDE.test(reply) || DUE.test(reply));
				},
			},
		],
	},

	// A weekday with no date: today when it is today's weekday and the time is still ahead.
	{
		name: 'bare weekday: Ellie\'s "on Tuesday" on a Tuesday is today',
		as: 'Ellie',
		asks: ['Remind me to pack my swim bag on Tuesday'],
		checks: [remindsOn('2026-10-06'), says(/today|6 October|October 6/i)],
	},
	{
		name: 'bare weekday: Lukas\'s "Tuesday at 18:30" on a Tuesday morning is today, with a real tag',
		as: 'Lukas',
		events: TAGGED_CALENDAR,
		asks: [
			'Remind me on Tuesday at 18:30 to pick Noah up after football, and what is on Saturday?',
		],
		checks: [
			remindsOn('2026-10-06', '18:30'),
			says(/today|6 October|October 6/i, /\b10\b/),
			// The real assistant tagged such a reminder "reminder", a tag the family did not have.
			noDraft('with a tag the family does not use', (d) =>
				((d.input.tags as string[] | undefined) ?? []).some(
					(tag) => !FAMILY_TAGS.includes(tag.toLowerCase()),
				),
			),
		],
	},
	{
		name: 'bare weekday: "Tuesday at 08:00" said at 10:00 on a Tuesday is next week',
		as: 'Lukas',
		asks: ['Remind me on Tuesday at 08:00 to put the bins out'],
		// The date is what this case is about: a draft can still fail on another field.
		checks: [
			{
				label: 'set the reminder or task for 2026-10-13',
				pass: (o) =>
					lastTurn(o).calls.some(
						(c) =>
							(c.actionId === 'calendar.createEvent' && c.input.date === '2026-10-13') ||
							(c.actionId === 'lists.addTask' && c.input.dueDate === '2026-10-13'),
					),
			},
			noDraft('on today', (d) => d.input.date === '2026-10-06' || d.input.dueDate === '2026-10-06'),
		],
	},
	// Round 5, asked on a Sunday: "this week" is the coming one.
	novak({
		name: 'Sunday: "this week" asked on the week\'s last day is the coming week',
		as: 'Mara',
		asks: ['What is on for the family this week?'],
		expect: { from: '2026-10-18', to: '2026-10-24', topics: ['calendar', 'tasks'] },
		checks: [
			says(/parents' evening/i, /football training/i, /swimming lesson/i, /piano lesson/i),
			says(/nona marija/i, /u13 match/i),
			neverSays(/date night/i),
		],
	}),
	novak({
		name: 'pick-up: "pick up Leo on Thursday" shows the swimming lesson and its note',
		as: 'Mara',
		asks: ['Do I need to pick up Leo on Thursday?'],
		expect: { from: '2026-10-22', to: '2026-10-22', topics: ['calendar'], people: ['Leo'] },
		checks: [says(/swimming lesson/i, /17:30/), neverSays(/\bno events?\b/i)],
	}),
	novak({
		name: "dinner elsewhere: Friday's dinner at Nona Marija's, with nothing in the meal plan",
		as: 'Ivy',
		asks: ['what is for dinner on friday?'],
		expect: { from: '2026-10-23', to: '2026-10-23', topics: ['meals', 'calendar'] },
		checks: [says(/nona marija/i)],
	}),
	novak({
		name: "notes: what to bring to Saturday's match is in the event's notes",
		as: 'Ivy',
		asks: ['what should I bring to the football match on Saturday?'],
		expect: { from: '2026-10-24', to: '2026-10-24', topics: ['calendar'], people: ['Ivy'] },
		checks: [says(/shin pads/i, /white shirt/i)],
	}),
	novak({
		name: 'waiting: a request from Leo and a Quick add card wait for Mara',
		as: 'Mara',
		drafts: [
			{
				by: 'Leo',
				action: 'calendar.createEvent',
				input: {
					title: "Sleepover at Max's",
					date: '2026-10-30',
					startTime: '18:00',
					memberIds: [],
				},
			},
			{
				by: 'quick-add',
				action: 'lists.addTask',
				input: { title: 'Buy a recorder for music class' },
				summary: 'School letter',
			},
		],
		asks: ['Is anything still waiting for me?'],
		expect: { from: '2026-10-18', to: '2026-10-24', topics: ['suggestions'], people: ['Mara'] },
		checks: [says(/sleepover/i, /recorder/i)],
	}),
	novak({
		name: 'nothing this weekend: the next event is Date night on Saturday 31 October',
		as: 'Tom',
		// On a Wednesday, so the weekend is still to come.
		today: '2026-10-21',
		events: NOVAK_WEEK.filter((e) => e.title === "Parents' evening" || e.title === 'Date night'),
		asks: ["What's on this weekend?"],
		expect: { from: '2026-10-24', to: '2026-10-25', topics: ['calendar'] },
		checks: [says(/\bnothing\b/i, /date night/i, /31 October/i)],
	}),
	novak({
		name: 'child: Leo (6) gets one short sentence',
		as: 'Leo',
		asks: ['what do I have this week?'],
		expect: { from: '2026-10-18', to: '2026-10-24', topics: ['calendar'], people: ['Leo'] },
		checks: [says(/swimming lesson/i), shortLead(1, 20)],
	}),
	novak({
		name: 'no ISO dates: when a task of Leo is due',
		as: 'Leo',
		asks: ['when is my reading homework due?'],
		expect: { from: '2026-10-18', to: '2026-10-24', topics: ['tasks'], people: ['Leo'] },
		checks: [says(/practise reading/i, /monday/i)],
	}),
	novak({
		name: 'pronoun: "his" in the second part is Leo, never a name nobody has',
		as: 'Ivy',
		asks: ['What is Leo doing this week, and is anything of his still open?'],
		expect: { from: '2026-10-18', to: '2026-10-24', topics: ['calendar'], people: ['Leo'] },
		checks: [
			{
				label: 'no card calls a pronoun a name, and every card is about Leo',
				pass: (o) => {
					const cards = lastTurn(o).cards ?? [];
					return (
						cards.length > 0 &&
						cards.every(
							(c) => c.understood.unmatched.length === 0 && c.understood.people.includes('Leo'),
						)
					);
				},
			},
			neverSays(/called his/i),
		],
	}),
];
