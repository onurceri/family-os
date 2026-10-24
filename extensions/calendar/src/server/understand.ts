import {
	addressesEveryone,
	defineMentionKind,
	endNamed,
	type FieldDecision,
	MENTION_NOTES_MAX,
	type Mention,
	type MentionContext,
	namesThing,
	peopleNamed,
	type Resolution,
	type ResolvedDay,
	refuse,
	UNSURE_TARGET,
	unsureFields,
	whichOne,
} from '@famos/sdk';
import {
	addDays,
	clockTimes,
	dateLocale,
	daysBetween,
	formatDate,
	repeatRule,
	zoned,
} from '@famos/time';
import { MAX_TAG_LENGTH, type Occurrence, tagKey } from '../contract/index.ts';
import { aiContextEvents } from './context.ts';
import { startOf } from './moved.ts';
import { events, expandRow, occurrencesBetween, SAME_EVENT_DAYS, sameTitle } from './store.ts';
import { aiContext as aiContextTags } from './tags.ts';

/*
 * What the model may read for the calendar from a shared message: new events, changes to events
 * the calendar has, and cancellations. The model names them in words; the resolvers find the
 * events meant among the family's own, read days, times and people, and leave out what is
 * already so.
 */

const TITLE_MAX = 120;
const PLACE_MAX = 200;
const LABEL_MAX = 200;
/** Tags a suggested event gets at most; people add more themselves. */
const TAGS_MAX = 2;
/** How far ahead an event a change or a cancellation names is looked for. */
const AHEAD_DAYS = 62;
/** A message seldom changes or cancels more than a few events; more is a runaway answer. */
const CHANGE_LIMIT = 4;
/**
 * New events read from one message: a letter seldom holds more, and text that tells the model
 * to add many cannot pile them up. Those beyond are refused as incomplete, so they are named.
 */
const EVENT_LIMIT = 6;
/**
 * A new event this close to one of the same name at the same time is that event with one of the
 * two dates wrong (a letter's typo, a misread day): a second one is not what the family needs.
 */
const MOVE_DAYS = 3;

const cut = (text: string, max: number) => [...text.trim()].slice(0, max).join('').trim();

/** Whether two titles name one event (`eventExists`'s test). */
const sameEvent = (ctx: MentionContext, a: string, b: string) =>
	sameTitle(a, b) || namesThing(a, b, { language: ctx.locale });

/** The family's own events with a date in the range, each with its dates in order. */
async function eventsBetween(ctx: MentionContext, from: string, to: string) {
	const found = await occurrencesBetween(ctx.db, from, to, ctx.timeZone);
	const byEvent = new Map<string, { id: string; label: string; dates: Occurrence[] }>();
	for (const o of found) {
		if (o.source !== null || !o.editable) continue;
		// A date moved out of a series is a date of that series, not an event of its own.
		const thing = o.seriesId ?? o.eventId;
		const entry = byEvent.get(thing) ?? { id: thing, label: o.title, dates: [] };
		entry.dates.push(o);
		byEvent.set(thing, entry);
	}
	const things = [...byEvent.values()];
	// The series' own title names the thing: a moved date may have been retitled.
	for (const t of things) {
		const own = t.dates.find((d) => d.eventId === t.id);
		if (own) t.label = own.title;
	}
	return things;
}

/** Whether a thing on the calendar repeats: a series, or a series whose date moved out. */
const repeats = (dates: readonly Occurrence[]) => dates.some((d) => d.recurring || d.seriesId);

/** The day a moved date was moved from, in the family time zone. */
function originalDay(o: Occurrence, timeZone: string): string | null {
	if (o.recurrenceKey === undefined) return null;
	return o.allDay
		? o.recurrenceKey
		: zoned(Number(o.recurrenceKey), timeZone).toPlainDate().toString();
}

/** `HH:MM` of an instant in the family time zone. */
const clockAt = (ms: number, timeZone: string) =>
	zoned(ms, timeZone).toPlainTime().toString().slice(0, 5);

/** A clock time as the parser keeps it, or null. */
const CLOCK = /\p{N}{1,2}[:.]\p{N}{2}/gu;

/**
 * Whether the time the model gave as the start is only when something ends ("back by 16:00",
 * "until 17:30"): the words just before it in the message are end words (`words_end_time`, in the
 * reader's languages). The model has a slot for the end, but a free one puts the time in the
 * start; a return time shown as the start of the event would be certain and wrong. Never when
 * the mention has an end of its own, since then the time is its start.
 */
function endsOnly(ctx: MentionContext, mention: Mention): boolean {
	if (mention.endTime || !mention.time) return false;
	const words = ctx
		.vocabulary('calendar:words_end_time')
		.map((w) => w.toLocaleLowerCase(ctx.locale));
	if (words.length === 0) return false;
	for (const hay of [mention.timeText, mention.quote]) {
		if (!hay) continue;
		const clocks = [...hay.matchAll(CLOCK)];
		const at = clocks.find((m) => m[0] === mention.time) ?? clocks.at(-1);
		if (!at) continue;
		const before = hay
			.slice(0, at.index)
			.toLocaleLowerCase(ctx.locale)
			.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
			.replace(/\s+/gu, ' ')
			.trim();
		if (words.some((w) => before === w || before.endsWith(` ${w}`))) return true;
	}
	return false;
}

/** The start the mention states: none when its only time is an end. */
function startedAt(ctx: MentionContext, mention: Mention) {
	// An end with no start of its own: the words' clock (`timeText`) is that end, not a start.
	if (mention.endTime && !mention.time) return null;
	if (endsOnly(ctx, mention)) return null;
	const read = ctx.time(mention);
	// The words' clock that only repeats the end ("bus leaves 07:30, back about 17:00" with the
	// end copied into `timeText`) is not the start: the start the model gave stands, sure only
	// when the message holds it.
	if (read && mention.time && mention.endTime === read.time && mention.time !== read.time)
		return {
			time: mention.time,
			certain: [mention.quote, mention.timeText].some((hay) =>
				clockTimes(hay ?? '').includes(mention.time as string),
			),
		};
	return read;
}

const clockOf = (value: string | undefined) =>
	value && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value) ? value : null;

/** Input fields of a new event, by the slots that fill them. */
const EVENT_FIELDS = {
	title: 'title',
	people: 'memberIds',
	date: 'date',
	endDate: 'endDate',
	time: 'startTime',
	endTime: 'endTime',
	repeat: 'recurrence',
	place: 'location',
	notes: 'notes',
	tags: 'tags',
} as const;

/**
 * The first date of a weekly repeat that names its weekdays but no day: the coming one of them,
 * today included while the time is still ahead.
 */
function firstOfWeekdays(
	ctx: MentionContext,
	weekdays: readonly number[],
	time: string | undefined,
): string | null {
	const dates = weekdays
		.map((weekday) => ctx.day({ text: '', weekday }, 'future', time)?.date)
		.filter((d): d is string => d !== undefined)
		.toSorted();
	return dates[0] ?? null;
}

const nameWords = (value: string, locale: string) =>
	value
		.toLocaleLowerCase(locale)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => [...word].length > 1);

/**
 * The one member whose whole name a new event's title writes, or else the words of the message it
 * rests on (its quote), when the mention names nobody and the shared message writes that name
 * too; null when none or several do, or the mention names people or the sharer itself.
 */
function memberWritten(ctx: MentionContext, mention: Mention): string | null {
	if ((mention.people?.length ?? 0) > 0 || mention.forMe) return null;
	const said = ctx.text === null ? null : new Set(nameWords(ctx.text, ctx.locale));
	const namedIn = (value: string | undefined) => {
		if (!value) return [];
		const words = new Set(nameWords(value, ctx.locale));
		return ctx.members.filter((m) => {
			const name = nameWords(m.displayName, ctx.locale);
			return (
				name.length > 0 &&
				name.every((w) => words.has(w)) &&
				(said === null || name.some((w) => said.has(w)))
			);
		});
	};
	for (const value of [mention.title, mention.quote]) {
		const named = namedIn(value);
		if (named.length > 0) return named.length === 1 ? (named[0]?.id ?? null) : null;
	}
	return null;
}

/** Tags as the family already writes them, new ones cut to size; at most `TAGS_MAX`. */
function tagsOf(words: readonly string[] | undefined, known: readonly { name: string }[]) {
	const out: string[] = [];
	for (const word of words ?? []) {
		const own = known.find((t) => tagKey(t.name) === tagKey(word));
		const name = own?.name ?? cut(word, MAX_TAG_LENGTH);
		if (name !== '' && !out.some((t) => tagKey(t) === tagKey(name))) out.push(name);
		if (out.length === TAGS_MAX) break;
	}
	return out;
}

/**
 * A new event from a mention: its day and time read, untimed as all day for a person to check,
 * and refused when the calendar has it already that day (and time).
 */
async function newEvent(
	ctx: MentionContext,
	known: readonly { name: string }[],
	index: number,
	mention: Mention,
): Promise<Resolution> {
	const title = cut(mention.title ?? '', TITLE_MAX);
	if (title === '') {
		return refuse('incomplete', mention.target ?? null, [index]);
	}
	const uncertain = new Set(unsureFields(mention, EVENT_FIELDS));
	// An event that only says when it is over has no start to give: it is an all-day event the
	// person is asked to check (the end is in the message's words, which the card quotes).
	const time = startedAt(ctx, mention);
	const day = mention.date ? ctx.day(mention.date, 'future', time?.time) : null;
	let date = day?.date ?? null;
	let doubt = day !== null && !day.certain;
	const decided: Record<string, FieldDecision> = {};
	let recurrence: unknown;
	if (mention.repeat) {
		const repeat = mention.repeat;
		const weekdays =
			repeat.every === 'week'
				? (repeat.weekdays ?? (mention.date?.weekday ? [mention.date.weekday] : []))
				: [];
		if (date === null && weekdays.length > 0) {
			date = firstOfWeekdays(ctx, weekdays, time?.time);
			decided.date = 'inferred';
		}
		// "Every Wednesday" names no week, but a series simply starts on the coming one.
		if (day?.why === 'weekday_only' && weekdays.length > 0) doubt = false;
		if (date !== null) {
			const until = repeat.until ? endNamed(ctx, repeat.until) : null;
			const rule = repeatRule({ ...repeat, weekdays }, date, until?.date);
			if (!rule.exact || (repeat.until && !until?.certain)) uncertain.add('recurrence');
			date = rule.start;
			recurrence = rule.recurrence;
		}
	}
	if (date === null) {
		return refuse('incomplete', title, [index]);
	}
	if (doubt) {
		uncertain.add('date');
		decided.date = 'inferred';
	}
	const allDay = time === null;
	// A day without a time is an all-day event whose time a person is asked to check.
	if (allDay) {
		uncertain.add('startTime');
		uncertain.add('allDay');
		decided.startTime = 'defaulted';
		decided.allDay = 'defaulted';
	} else if (!time.certain) uncertain.add('startTime');
	const endTime = allDay ? null : clockOf(mention.endTime);
	let endDate: string | null = null;
	if (allDay && mention.endDate) {
		const last = ctx.day(mention.endDate, 'future');
		if (last && last.date > date) endDate = last.date;
		if (!last?.certain || last.date < date) uncertain.add('endDate');
	}
	let people = peopleNamed(ctx, mention);
	const titled = people.ids.length === 0 ? memberWritten(ctx, mention) : null;
	// The model wrote who it is for into the title ("Deniz vaccination appointment"), or left out
	// the name its own words hold ("Selin's dentist appointment"): the event is theirs, as a
	// guess for a person to check.
	if (titled) people = { ids: [titled], certain: false, unmatched: [] };
	if (!people.certain) uncertain.add('memberIds');
	// Nobody named: the event is the whole family's, which is a default, unless the message says
	// so ("everyone", "the whole family").
	if (
		people.ids.length === 0 &&
		!addressesEveryone(ctx.text, ctx.vocabulary('calendar:words_everyone'), ctx.locale)
	)
		decided.memberIds = 'defaulted';

	// The same event already on the calendar that very day (and time): leave it out.
	const sameDay = await occurrencesBetween(ctx.db, date, date, ctx.timeZone);
	const there = sameDay.some((o) => {
		if (!sameEvent(ctx, title, o.title)) return false;
		const at = startOf(o, ctx.timeZone);
		return at.date === date && (allDay || at.time === time?.time);
	});
	if (there) {
		return refuse('already', title, [index]);
	}
	const moved = recurrence === undefined ? await sameEventNear(ctx, title, date, time) : null;
	if (moved) {
		return {
			propose: {
				actionId: 'calendar.changeEvent',
				input: { id: moved.eventId, date, label: cut(title, LABEL_MAX) },
				subject: title,
				targetTitle: moved.title,
				// One of the two dates is wrong, and only a person can say which.
				uncertain: ['date'],
				from: [index],
			},
		};
	}
	const tags = tagsOf(mention.tags, known);
	const place = mention.place ? cut(mention.place, PLACE_MAX) : '';
	const notes = mention.notes ? cut(mention.notes, MENTION_NOTES_MAX) : '';
	return {
		propose: {
			actionId: 'calendar.createEvent',
			input: {
				title,
				...(time ? { startTime: time.time } : { allDay: true }),
				date,
				...(endDate && { endDate }),
				...(endTime && endTime !== time?.time && { endTime }),
				memberIds: people.ids,
				...(place && { location: place }),
				...(notes && { notes }),
				...(recurrence !== undefined && { recurrence }),
				...(tags.length > 0 && { tags }),
			},
			subject: title,
			uncertain: [...uncertain],
			decided,
			from: [index],
		},
	};
}

/**
 * The one single event of the same name a few days from `date`, at the same time (any time when
 * either is all day), or null when there is none or several.
 */
async function sameEventNear(
	ctx: MentionContext,
	title: string,
	date: string,
	time: { time: string } | null,
): Promise<Occurrence | null> {
	const near = await occurrencesBetween(
		ctx.db,
		addDays(date, -MOVE_DAYS),
		addDays(date, MOVE_DAYS),
		ctx.timeZone,
	);
	const same = near.filter((o) => {
		if (o.recurring || o.source !== null || !o.editable || !sameEvent(ctx, title, o.title))
			return false;
		const at = startOf(o, ctx.timeZone);
		return at.date !== date && (time === null || o.allDay || at.time === time.time);
	});
	const ids = new Set(same.map((o) => o.eventId));
	return ids.size === 1 ? (same[0] as Occurrence) : null;
}

export const event = defineMentionKind({
	id: 'calendar.event',
	describe:
		'Something that happens at a date, usually at a time: an appointment, a class, a trip, a visit, a delivery, a service, a repeating activity. A letter that repeats an event the calendar has is read the same way. Not news that a known event moved or changed (calendar.eventChange) or is off (calendar.eventCancel), and not a deadline to do something by (lists.task).',
	slots: {
		title:
			'Short, in the family language ("Dentist", "Zoo trip"); a person, pet or thing it is for that is not in the family is named in it',
		people:
			'The family members it is for, only when the message names them or says "me"/"my"; left out for the whole family',
		date: 'The day it is, or the first day of a repeating one',
		endDate: 'The last day of an event that lasts several days',
		time: 'The start time, only when written',
		endTime: 'The end time, only when written',
		repeat:
			'Only when the message says it repeats; its end (until) copied as words, or the number of times',
		place: 'Where it is',
		notes: 'What to bring or know, briefly',
		tags: 'One or two short labels; a known tag when one fits',
	},
	actions: ['calendar.createEvent', 'calendar.changeEvent'],
	knownFrom: [aiContextTags.id, aiContextEvents.id],
	limit: EVENT_LIMIT,
	examples: [
		{
			text: 'Ivy has the dentist next Thursday at 4:30pm, and Max has his vaccination appointment at the vet on Friday at 10:00',
			mentions: [
				{
					kind: 'calendar.event',
					quote: 'Ivy has the dentist next Thursday at 4:30pm',
					title: 'Dentist',
					people: ['Ivy'],
					date: { text: 'next Thursday', weekday: 4, week: 'next' },
					time: '16:30',
					timeText: '4:30pm',
				},
				{
					kind: 'calendar.event',
					quote: 'Max has his vaccination appointment at the vet on Friday at 10:00',
					title: "Max's vaccination at the vet",
					date: { text: 'Friday', weekday: 5 },
					time: '10:00',
					timeText: '10:00',
				},
			],
			why: 'An appointment still to come is an event, also for a pet or a car: the vaccination is not given yet.',
		},
		{
			text: "Leo's piano lesson is every Wednesday at 17:00, until the end of October",
			mentions: [
				{
					kind: 'calendar.event',
					quote: "Leo's piano lesson is every Wednesday at 17:00, until the end of October",
					title: 'Piano lesson',
					people: ['Leo'],
					date: { text: 'every Wednesday', weekday: 3 },
					time: '17:00',
					timeText: '17:00',
					repeat: {
						every: 'week',
						weekdays: [3],
						until: { text: 'until the end of October', month: 10 },
					},
				},
			],
			why: 'The end is copied as its words; code works out its last day.',
		},
		{
			text: 'Choir concert on Thursday in the town hall. No phones during the songs, please. Bring your black folder.',
			mentions: [
				{
					kind: 'calendar.event',
					quote: 'Choir concert on Thursday in the town hall',
					title: 'Choir concert',
					date: { text: 'Thursday', weekday: 4 },
					place: 'Town hall',
					notes: 'No phones during the songs. Bring your black folder.',
				},
			],
			why: 'No time is written, so none is given. A rule for those who come and what to bring are the notes of the event.',
		},
		{
			text: 'Saturday match vs Riverside: meet at the school gate 9:15, kick-off 10:00. Bring white shirt, shin pads and water.',
			mentions: [
				{
					kind: 'calendar.event',
					quote: 'Saturday match vs Riverside: meet at the school gate 9:15, kick-off 10:00',
					title: 'Match vs Riverside',
					date: { text: 'Saturday', weekday: 6 },
					time: '09:15',
					timeText: '9:15',
					place: 'School gate',
					notes: 'Bring white shirt, shin pads and water',
				},
			],
			why: 'What to take along to an event is its notes; it is not something to buy.',
		},
		{
			text: 'Note to self: my check-up is on Saturday 10 October at 9am. Family picnic on Sunday at noon, everyone welcome.',
			mentions: [
				{
					kind: 'calendar.event',
					quote: 'my check-up is on Saturday 10 October at 9am',
					title: 'Check-up',
					forMe: true,
					date: { text: 'Saturday 10 October', day: 10, month: 10, weekday: 6 },
					time: '09:00',
					timeText: '9am',
				},
				{
					kind: 'calendar.event',
					quote: 'Family picnic on Sunday at noon',
					title: 'Family picnic',
					date: { text: 'Sunday', weekday: 7 },
					time: '12:00',
					timeText: 'noon',
				},
			],
			why: '"My" is the person who shared it; an event for everyone names nobody.',
		},
		{
			text: "Class 3A's trip to the science museum is tomorrow. Children should be at school by 8:30 and will be back around 15:00.",
			mentions: [
				{
					kind: 'calendar.event',
					quote: "Class 3A's trip to the science museum is tomorrow",
					title: 'Science museum trip',
					people: ['Ivy'],
					peopleGuessed: true,
					date: { text: 'tomorrow', inDays: 1 },
					time: '08:30',
					timeText: '8:30',
					endTime: '15:00',
					place: 'Science museum',
				},
			],
			why: "Nobody is named, but Ivy's description in the family list says class 3A, so she is chosen as a guess. It starts when they must be there and ends when they are back.",
		},
		{
			text: 'My mum has her eye test on Monday 19 October at 11:00, and my brother is taking her',
			mentions: [
				{
					kind: 'calendar.event',
					quote: 'My mum has her eye test on Monday 19 October at 11:00',
					title: 'Eye test',
					people: ['Rosa', 'Leo'],
					peopleGuessed: true,
					date: { text: 'Monday 19 October', day: 19, month: 10, weekday: 1 },
					time: '11:00',
					timeText: '11:00',
				},
			],
			why: 'The family list describes Rosa as the mother and Leo as the brother of the person who shared it: people are always given by their names from the list, never as "mum" or "brother".',
		},
	],
	decides: {
		memberIds: 'defaulted',
		startTime: 'defaulted',
		allDay: 'defaulted',
		date: 'inferred',
		recurrence: 'inferred',
	},
	async resolve(ctx, mentions) {
		const known = await events(ctx.db).selectFrom('calendar_tags').select('name').execute();
		const out: Resolution[] = [];
		for (const { index, mention } of mentions) out.push(await newEvent(ctx, known, index, mention));
		return out;
	},
});

/** An event a change or a cancellation names, among the family's coming ones. */
type Found =
	| {
			event: { id: string; label: string; dates: Occurrence[] };
			/** The day the message gives was what told equally named events apart. */
			byDay?: true;
	  }
	| { refusal: Resolution };

/** Whether a date is the day read, or inside the span read ("this week"). */
const within = (date: string, day: ResolvedDay) =>
	day.to === undefined ? date === day.date : date >= day.date && date <= day.to;

/**
 * The event `target` words name, by its name among all coming ones: the day the message gives
 * only decides between events the words name equally well. A name that merely appears in the
 * title of something else that day ("Pick Ivy up after football") must not win over the event
 * the words name ("Football training") because of the day.
 */
function eventNamed(
	ctx: MentionContext,
	coming: Awaited<ReturnType<typeof eventsBetween>>,
	words: string,
	day: ResolvedDay | null,
	index: number,
): Found {
	const found = ctx.target(words, coming);
	if ('found' in found) return { event: found.found };
	if ('none' in found) return { refusal: refuse('unknown', words, [index]) };
	// The day decides only between events the words name equally well, never for a guess.
	if (day && !found.unsure) {
		const onDay = found.ambiguous.filter((e) =>
			e.dates.some((o) => within(startOf(o, ctx.timeZone).date, day)),
		);
		if (onDay.length === 1) return { event: onDay[0] as (typeof coming)[number], byDay: true };
	}
	return { refusal: refuse('ambiguous', whichEvent(ctx, words, found.ambiguous), [index]) };
}

/**
 * The "which one?" subject of equally named events. Their names tell them apart when they differ;
 * events with one name ("Leo swimming") are told by the day each is next on
 * ("Leo swimming (Thu 22 Oct, Wed 28 Oct)").
 */
function whichEvent(
	ctx: MentionContext,
	words: string,
	candidates: readonly { label: string; dates: readonly Occurrence[] }[],
): string {
	const named = whichOne(words, candidates);
	if (named !== words) return named;
	const locale = dateLocale(ctx.locale, ctx.formatLocale, ctx.hourCycle);
	const days = candidates.flatMap((e) => {
		const first = e.dates[0];
		return first
			? [
					formatDate(startOf(first, ctx.timeZone).date, locale, {
						weekday: 'short',
						day: 'numeric',
						month: 'short',
					}),
				]
			: [];
	});
	// The days hold commas in some formats, so they are set apart by a slash.
	return days.length === 0 ? words : `${words} (${days.slice(0, 4).join(' / ')})`;
}

/** The date of an event nearest to a day (the earlier one on a tie). */
function nearest(dates: readonly Occurrence[], day: string, timeZone: string): Occurrence {
	return dates
		.map((o) => ({ o, date: startOf(o, timeZone).date }))
		.toSorted(
			(a, b) =>
				Math.abs(daysBetween(a.date, day)) - Math.abs(daysBetween(b.date, day)) ||
				a.date.localeCompare(b.date),
		)[0]?.o as Occurrence;
}

/** The words that name the event a change or a cancellation is about. */
const targetWords = (mention: Mention) => (mention.target ?? mention.title)?.trim() ?? '';

/** Input fields of a change, by the slots that fill them. */
const CHANGE_FIELDS = {
	date: 'date',
	time: 'startTime',
	endTime: 'endTime',
	place: 'location',
} as const;

/** A change of an event the calendar lacks, read as that event at its new day and time. */
const asNewEvent = (mention: Mention, words: string): Mention => ({
	kind: 'calendar.event',
	title: words,
	...(mention.date && { date: mention.date }),
	...(mention.time && { time: mention.time }),
	...(mention.timeText && { timeText: mention.timeText }),
	...(mention.endTime && { endTime: mention.endTime }),
	...(mention.place && { place: mention.place }),
	...(mention.unsure && { unsure: mention.unsure }),
});

export const eventChange = defineMentionKind({
	id: 'calendar.eventChange',
	describe:
		'News that an event the calendar already has moved or changed: a new day, a new time or a new place. The target names the event; the other slots hold only what is new.',
	slots: {
		target: 'The event as the message names it, without its day ("Regional gala")',
		date: 'The new day, only when it moves to another day',
		time: 'The new start time, only when written',
		endTime: 'The new end time, only when written',
		place: 'The new place, only when it changes',
	},
	actions: ['calendar.changeEvent', 'calendar.createEvent'],
	knownFrom: [aiContextEvents.id],
	limit: CHANGE_LIMIT,
	examples: [
		{
			text: 'Regional gala moved to Sat 14 Nov 09:00',
			mentions: [
				{
					kind: 'calendar.eventChange',
					quote: 'Regional gala moved to Sat 14 Nov 09:00',
					target: 'Regional gala',
					date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
					time: '09:00',
					timeText: '09:00',
				},
			],
			why: 'The gala is on the calendar: it moves, it is not a second gala.',
		},
		{
			text: "Saturday's match against Hill Rovers is moved to Sunday 15 November at 11:00 at the north pitch (was 9:30 at the school field)",
			mentions: [
				{
					kind: 'calendar.eventChange',
					quote:
						"Saturday's match against Hill Rovers is moved to Sunday 15 November at 11:00 at the north pitch",
					target: 'Match against Hill Rovers',
					date: { text: 'Sunday 15 November', day: 15, month: 11, weekday: 7 },
					time: '11:00',
					timeText: '11:00',
					place: 'North pitch',
				},
			],
			why: 'What it was ("was 9:30") only tells which event moves; the slots hold what is new.',
		},
		{
			text: "Parents' evening will be in the school hall, starting at 19:00",
			mentions: [
				{
					kind: 'calendar.eventChange',
					quote: "Parents' evening will be in the school hall, starting at 19:00",
					target: "Parents' evening",
					time: '19:00',
					timeText: '19:00',
					place: 'School hall',
				},
			],
		},
	],
	decides: { date: 'inferred', startTime: 'inferred' },
	async resolve(ctx, mentions) {
		const out: Resolution[] = [];
		let known: { name: string }[] | undefined;
		for (const { index, mention } of mentions) {
			const words = targetWords(mention);
			if (words === '') {
				out.push(refuse('incomplete', null, [index]));
				continue;
			}
			const uncertain = new Set(unsureFields(mention, CHANGE_FIELDS));
			const endOnly = endsOnly(ctx, mention);
			const time = startedAt(ctx, mention);
			const day: ResolvedDay | null = mention.date
				? ctx.day(mention.date, 'future', time?.time)
				: null;
			const endTime = clockOf(endOnly ? mention.time : mention.endTime);
			const place = mention.place ? cut(mention.place, PLACE_MAX) : '';
			if (!day && !time && !endTime && !place) {
				out.push(refuse('incomplete', words, [index]));
				continue;
			}
			const to = addDays(ctx.today, AHEAD_DAYS);
			const reach = day && day.date > to ? addDays(day.date, SAME_EVENT_DAYS) : to;
			const found = eventNamed(ctx, await eventsBetween(ctx, ctx.today, reach), words, day, index);
			if ('refusal' in found) {
				// News that something the calendar does not have moved to a day ("the bin
				// collection moves to 09/10") still says when it now is: that is a new event, which
				// the person checks. Without a day there is nothing to add.
				const unknown = 'refuse' in found.refusal && found.refusal.refuse.reason === 'unknown';
				if (unknown && day) {
					known ??= await events(ctx.db).selectFrom('calendar_tags').select('name').execute();
					out.push(await newEvent(ctx, known, index, asNewEvent(mention, words)));
				} else out.push(found.refusal);
				continue;
			}
			const { dates, label } = found.event;
			const first = dates[0] as Occurrence;
			// A day alone chose between equally named events (a span, "this week", is a firmer
			// choice): the person checks which one it is.
			const chosenByDay = found.byDay && day?.to === undefined;
			// One date of a repeating event moves: the one nearest the new day. Without a new day,
			// the change is to the whole series.
			const o =
				repeats(dates) && day
					? nearest(dates, day.date, ctx.timeZone)
					: (dates.find((d) => d.recurring) ?? first);
			const at = startOf(o, ctx.timeZone);
			const change: Record<string, unknown> = {};
			if (day && day.date !== at.date) change.date = day.date;
			if (time) {
				if (o.allDay) change.allDay = false;
				if (o.allDay || time.time !== at.time) change.startTime = time.time;
			}
			const ends = o.end === null ? null : clockAt(o.end, ctx.timeZone);
			if (endTime && endTime !== ends && endTime !== time?.time) change.endTime = endTime;
			if (place && place !== o.location) change.location = place;
			if (Object.keys(change).length === 0) {
				out.push(refuse('already', words, [index]));
				continue;
			}
			const decided: Record<string, FieldDecision> = {};
			if (change.date && day && !day.certain) {
				uncertain.add('date');
				decided.date = 'inferred';
			}
			if (change.startTime && time && !time.certain) {
				uncertain.add('startTime');
				decided.startTime = 'inferred';
			}
			out.push({
				propose: {
					actionId: 'calendar.changeEvent',
					input: {
						// Without a day the change is to the series, even when its next date is a moved one.
						id: repeats(dates) && !day ? found.event.id : o.eventId,
						...(o.recurring && day && { occurrence: o.key }),
						...change,
						label: cut(words, LABEL_MAX),
					},
					subject: words,
					targetTitle: label,
					uncertain: [
						...[...uncertain].filter((f) => f in change),
						...(chosenByDay ? [UNSURE_TARGET] : []),
					],
					decided,
					from: [index],
				},
			});
		}
		return out;
	},
});

export const eventCancel = defineMentionKind({
	id: 'calendar.eventCancel',
	describe:
		'News that an event the calendar has is off: cancelled, called off, not happening. For a repeating event, the date says which one. Never a new event about the cancellation.',
	slots: {
		target: 'The event as the message names it, without its day ("football")',
		date: 'The day that is off, when the message says',
	},
	actions: ['calendar.deleteEvent'],
	knownFrom: [aiContextEvents.id],
	limit: CHANGE_LIMIT,
	examples: [
		{
			text: 'no choir wednesday, the hall is booked!! pls tell the others',
			mentions: [
				{
					kind: 'calendar.eventCancel',
					quote: 'no choir wednesday',
					target: 'choir',
					date: { text: 'wednesday', weekday: 3 },
				},
			],
			why: 'News that it is off cancels that date; it is not a new event.',
		},
		{
			text: 'Swimming is cancelled this week, the pool is closed for repairs',
			mentions: [
				{
					kind: 'calendar.eventCancel',
					quote: 'Swimming is cancelled this week',
					target: 'swimming',
					date: { text: 'this week', week: 'this' },
				},
			],
			why: 'A week named without a day is copied as the week; code finds the date in it.',
		},
		{
			text: 'The piano recital is called off',
			mentions: [
				{
					kind: 'calendar.eventCancel',
					quote: 'The piano recital is called off',
					target: 'piano recital',
				},
			],
		},
	],
	decides: { occurrence: 'inferred' },
	async resolve(ctx, mentions) {
		const out: Resolution[] = [];
		const coming = await eventsBetween(ctx, ctx.today, addDays(ctx.today, AHEAD_DAYS));
		const cancelled = new Map<string, number[]>();
		for (const { index, mention } of mentions) {
			const words = targetWords(mention);
			if (words === '') {
				out.push(refuse('incomplete', null, [index]));
				continue;
			}
			let day = mention.date ? ctx.day(mention.date, 'future') : null;
			const found = eventNamed(ctx, coming, words, day, index);
			if ('refusal' in found) {
				out.push(found.refusal);
				continue;
			}
			const { dates, label } = found.event;
			const first = dates[0] as Occurrence;
			const uncertain: string[] = [];
			const decided: Record<string, FieldDecision> = {};
			let o = first;
			// The event exists, on another day than the message says: told with the day it is on,
			// in the family's formats, so the person can open it and decide.
			const offDay = refuse(
				'other_day',
				`${label} (${formatDate(
					startOf(first, ctx.timeZone).date,
					dateLocale(ctx.locale, ctx.formatLocale, ctx.hourCycle),
					{ weekday: 'short', day: 'numeric', month: 'short' },
				)})`,
				[index],
			);
			if (repeats(dates)) {
				// Read the day again at the time it happens: a weekday named on that very day after
				// the event is next week's.
				if (mention.date && !first.allDay)
					day = ctx.day(mention.date, 'future', startOf(first, ctx.timeZone).time);
				if (day?.to !== undefined) {
					// A span ("this week"): its date in that span, sure when it has only one there.
					const span = day;
					const inside = dates.filter((d) => within(startOf(d, ctx.timeZone).date, span));
					if (inside.length === 0) {
						out.push(offDay);
						continue;
					}
					o = inside[0] as Occurrence;
					if (inside.length > 1) {
						uncertain.push('occurrence');
						decided.occurrence = 'inferred';
					}
				} else if (day) {
					const on = dates.find((d) => startOf(d, ctx.timeZone).date === day?.date);
					// A date moved to another day is still the series' date of the day it left: the
					// message names that day, and the date to cancel is the moved one.
					const left = on
						? undefined
						: dates.find((d) => originalDay(d, ctx.timeZone) === day?.date);
					if (left) {
						o = left;
						uncertain.push(UNSURE_TARGET);
					} else {
						if (!on && (await skippedOn(ctx, found.event.id, day.date))) {
							out.push(refuse('already', words, [index]));
							continue;
						}
						o = on ?? nearest(dates, day.date, ctx.timeZone);
					}
					// A weekday alone ("thursday") names the coming date of a series on that weekday.
					const sure = day.certain || (on !== undefined && day.why === 'weekday_only');
					if (!left && (!on || !sure)) {
						uncertain.push('occurrence');
						decided.occurrence = 'inferred';
					}
				} else {
					uncertain.push('occurrence');
					decided.occurrence = 'inferred';
				}
			} else if (day && !within(startOf(first, ctx.timeZone).date, day)) {
				// A single event on another day than the message says is not the one it means.
				out.push(offDay);
				continue;
			}
			const key = `${o.eventId}:${o.recurring ? o.key : ''}`;
			const seen = cancelled.get(key);
			if (seen) {
				seen.push(index);
				continue;
			}
			const from = [index];
			cancelled.set(key, from);
			out.push({
				propose: {
					actionId: 'calendar.deleteEvent',
					input: {
						id: o.eventId,
						...(o.recurring && { occurrence: o.key }),
						label: cut(words, LABEL_MAX),
					},
					subject: words,
					targetTitle: label,
					removes: true,
					uncertain,
					decided,
					from,
				},
			});
		}
		return out;
	},
});

/** Whether a repeating event has a date on `day` that was taken out of it already. */
async function skippedOn(ctx: MentionContext, id: string, day: string): Promise<boolean> {
	const row = await events(ctx.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	if (!row?.rrule || !row.exdates) return false;
	return expandRow({ ...row, exdates: null }, day, day, ctx.timeZone).length > 0;
}

export const calendarKinds = [event, eventChange, eventCancel];
