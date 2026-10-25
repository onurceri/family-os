import { defineAction, digestNotes, FamosError, searchFinds } from '@famos/sdk';
import { addDays, daysBetween, formatDate, IsoDateSchema, todayIn, zoned } from '@famos/time';
import { z } from 'zod';
import { MemberIdSchema, tagKey } from '../contract/index.ts';
import { calendarView } from './capabilities.ts';
import { events, occurrencesBetween, sortOccurrences } from './store.ts';
import { externalOccurrencesBetween } from './subscriptions.ts';
import { whenOf } from './when.ts';

export const MAX_RANGE_DAYS = 62;

const MAX_FOUND = 60;

/**
 * The most days (a week) a text search that found nothing lists the other events of: the thing
 * asked about may be among them under other words.
 */
const UNMATCHED_MAX_DAYS = 7;

/** How many days a range covers, both ends included. */
const daysIn = (from: string, to: string) => daysBetween(from, to) + 1;

/** How far past the searched range a search for the next match looks. */
const NEXT_MATCH_DAYS = 366;

/** `HH:MM` of an instant in the family time zone. */
const clock = (ms: number, timeZone: string) =>
	zoned(ms, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

/** One event as `calendar.findEvents` gives it to the model. */
const FoundEventSchema = z.object({
	id: z
		.string()
		.nullable()
		.describe('The event, for changing or deleting it; null for subscribed calendars'),
	occurrence: z
		.string()
		.optional()
		.describe(
			'Repeating events only: the key of this date, for changing or deleting only that one',
		),
	title: z.string(),
	date: z.string(),
	weekday: z
		.string()
		.describe('The weekday of `date`, in English: read it from here, never work it out'),
	endDate: z.string().nullable(),
	time: z.string().nullable().describe('HH:MM-HH:MM local time; null for all-day events'),
	memberIds: z.array(z.string()).describe('Left out means the whole family'),
	location: z.string().nullable(),
	notes: z
		.string()
		.optional()
		.describe("What the event's notes say (what to bring, details); left out when it has none"),
	tags: z.array(z.string()),
	recurring: z.literal(true).optional().describe('Only on repeating events'),
	external: z.literal(true).optional().describe('Only on events from a subscribed calendar'),
	when: z
		.enum(['past', 'now', 'upcoming'])
		.optional()
		.describe(
			'Only for today and what is on now. past: already over; now: happening now (or today, all day); upcoming: still ahead. Other days are before or after today by their date',
		),
});

export const findEvents = defineAction({
	id: 'calendar.findEvents',
	title: 'Find events in a date range, for the AI',
	input: z.object({
		from: IsoDateSchema.optional().describe(
			'First day, YYYY-MM-DD; required unless `text` is given (then it defaults to today). Without `to` and `text` it means that one day',
		),
		to: IsoDateSchema.optional().describe(
			'Last day (inclusive), YYYY-MM-DD; at most 62 days after `from`; with `text` it defaults to 62 days after `from`',
		),
		text: z
			.string()
			.trim()
			.max(80)
			.optional()
			.describe(
				'Only events whose title or place contains this text or a form of its words ("swimming" also finds "Swim training"), e.g. "swimming". Without `from` and `to` it searches from today on',
			),
		members: z
			.array(MemberIdSchema)
			.max(10)
			.optional()
			.describe(
				'Leave it out (the default) for the whole family calendar: overviews and "what is on" questions, also when the person says "give me" or "show me" (that is who gets the answer, not whose events). Only for a question about specific people\'s own events ("my calendar", "what do I have", "am I free", "Noah\'s week"): what involves these people, plus events for the whole family',
			),
		tag: z
			.string()
			.trim()
			.max(40)
			.optional()
			.describe('Only events with this existing family tag; leave out unless a tag was named'),
	}),
	output: z.object({
		events: z.array(FoundEventSchema),
		truncated: z.boolean(),
		forOthers: z
			.array(FoundEventSchema)
			.optional()
			.describe(
				'Only when `members` left a search by `text` empty: the matches in the range for other members',
			),
		unmatched: z
			.array(FoundEventSchema)
			.optional()
			.describe(
				'Only when a search by `text` over at most 7 days found nothing but those days have other events: those events, so the answer can come from them (a "pick-up" may be a "Swimming lesson")',
			),
		note: z.string().optional(),
		nextMatch: z
			.object({
				id: z.string().nullable().describe('The event; null for subscribed calendars'),
				occurrence: z.string().optional(),
				title: z.string(),
				date: z.string(),
			})
			.optional()
			.describe('Only when nothing is in the range: the next event after it (of the same search)'),
	}),
	readOnly: true,
	requires: calendarView.id,
	ai: {
		description:
			'Finds what is on the family calendar between two dates (inclusive), repeating events expanded and subscribed calendars included, in time order. Events of today say whether they are past, happening now or upcoming. To find one thing, give a short `text` from its title. Use it for "what is on this week / on Saturday / is the dentist booked" questions.',
		guidance:
			'Resolve relative dates ("this week", "tomorrow") from today in the family time zone. For what is coming up (also "this week"), start at today. Never present an event whose when is past, or whose date is before today, as coming up.',
	},
	async run(uow, { from: fromDay, to: toDayGiven, tag, text, members }) {
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const today = todayIn(timeZone, now);
		if (!text && !fromDay) {
			const got = Object.entries({ from: fromDay, to: toDayGiven, tag, text, members })
				.filter(([, value]) => value !== undefined)
				.map(([key]) => key);
			throw new FamosError(
				'bad_request',
				`Give \`from\` (alone it means that one day) and optionally \`to\`, or a \`text\` to search for. Received: ${got.length > 0 ? got.join(', ') : 'nothing'}.`,
			);
		}
		// Without a text, `from` alone is that one day.
		const toDay = toDayGiven ?? (text ? undefined : fromDay);
		// Looking for one thing by name does not need dates: it is searched for from today on.
		const from = fromDay ?? today;
		const to = toDay ?? addDays(from, MAX_RANGE_DAYS);
		if (daysBetween(from, to) > MAX_RANGE_DAYS || to < from) {
			throw new FamosError('bad_request', `The range may span at most ${MAX_RANGE_DAYS} days`);
		}
		const wanted = tag?.toLocaleLowerCase();
		const needle = text?.toLocaleLowerCase();
		const notes: string[] = [];
		// A tag nobody uses finds nothing; say so, so the model tries a text filter instead.
		if (tag) {
			const known = await events(uow.db)
				.selectFrom('calendar_tags')
				.select('key')
				.where('key', '=', tagKey(tag))
				.executeTakeFirst();
			if (!known) notes.push(`There is no family tag "${tag}"; use \`text\` to search by subject.`);
		}
		const between = async (a: string, b: string, byMembers = true, bySearch = true) => {
			const [own, external] = await Promise.all([
				occurrencesBetween(uow.db, a, b, timeZone, { withNotes: true }),
				externalOccurrencesBetween(uow.db, a, b, timeZone),
			]);
			return sortOccurrences([...own, ...external], timeZone)
				.filter(
					(o) =>
						!byMembers ||
						!members?.length ||
						o.memberIds.length === 0 ||
						o.memberIds.some((m) => (members as readonly string[]).includes(m)),
				)
				.filter((o) => !wanted || o.tags.some((t) => t.toLocaleLowerCase() === wanted))
				.filter(
					(o) =>
						!bySearch ||
						!needle ||
						searchFinds(needle, o.title) ||
						searchFinds(needle, o.location ?? ''),
				);
		};
		const all = await between(from, to);
		// What the person filter left out is told, so an agent that filtered when the question was
		// about the whole family learns there is more instead of answering "nothing". A search by
		// name that the filter left empty also shows the other members' matches: "the swimming"
		// may be anyone's, and only the person's words say whether it had to be theirs.
		type Found = (typeof all)[number];
		let forOthers: Found[] = [];
		if (members?.length) {
			const unfiltered = await between(from, to, false);
			const others = unfiltered.length - all.length;
			if (all.length === 0 && needle && others > 0) {
				forOthers = unfiltered.slice(0, MAX_FOUND);
				notes.push(
					'Nothing in this range for the members asked about; the matches in it for other members are in forOthers.',
				);
			} else if (others > 0)
				notes.push(
					`${others} more ${others === 1 ? 'event matches' : 'events match'} in this range for other members only; leave \`members\` out to see them.`,
				);
		}
		// A search by words that matched nothing does not mean the range is empty: the person's
		// words ("pick up") need not be the title's ("Swimming lesson"). Over a few days, say what
		// else is there; over a longer range that would be the whole calendar and bury the answer,
		// so the note asks for fewer days instead.
		let unmatched: Found[] = [];
		if (all.length === 0 && needle && forOthers.length === 0) {
			const rest = await between(from, to, true, false);
			if (rest.length > 0 && daysIn(from, to) <= UNMATCHED_MAX_DAYS) {
				unmatched = rest.slice(0, MAX_FOUND);
				notes.push(
					`No event's title or place matches "${text}", but ${rest.length === 1 ? 'this other event is' : `these ${rest.length} other events are`} in the range (see unmatched); the one asked about may be among them under other words.`,
				);
			} else if (rest.length > 0) {
				notes.push(
					`No event's title or place matches "${text}". Search a shorter range (a day or a week) to see what else is on.`,
				);
			}
		}
		let nextMatch:
			| { id: string | null; occurrence?: string; title: string; date: string }
			| undefined;
		// Nothing in the range, but the same search finds something later: say what and when,
		// so the answer is "nothing this weekend; the next one is on …" and not "there is none".
		if (all.length === 0) {
			const next = (await between(addDays(to, 1), addDays(to, NEXT_MATCH_DAYS)))[0];
			if (next) {
				const day = next.allDay
					? (next.startDate as string)
					: zoned(next.start as number, timeZone)
							.toPlainDate()
							.toString();
				notes.push(
					`Nothing from ${from} to ${to}. The next ${needle || wanted ? 'match' : 'event'} after it is "${next.title}" on ${day} (see nextMatch).`,
				);
				nextMatch = {
					id: next.source === null ? next.eventId : null,
					...(next.recurring && { occurrence: next.key }),
					title: next.title,
					date: day,
				};
			}
		}
		if (all.length > MAX_FOUND)
			notes.push(
				`Only the first ${MAX_FOUND} of ${all.length} events are shown. Narrow the query (a shorter date range or a text filter) to see the rest.`,
			);
		const view = (o: Found) => {
			const date = o.allDay
				? (o.startDate as string)
				: zoned(o.start as number, timeZone)
						.toPlainDate()
						.toString();
			const when = whenOf(o, now, today);
			const notes = digestNotes(o.notes);
			return {
				id: o.source === null ? o.eventId : null,
				...(o.recurring && { occurrence: o.key }),
				title: o.title,
				date,
				// Models work weekdays out wrongly from a date; code gives it.
				weekday: formatDate(date, 'en', { weekday: 'long' }),
				endDate: o.allDay && o.endDate && o.endDate !== o.startDate ? o.endDate : null,
				time:
					!o.allDay && o.start !== null
						? `${clock(o.start, timeZone)}${o.end !== null ? `-${clock(o.end, timeZone)}` : ''}`
						: null,
				memberIds: o.memberIds,
				location: o.location,
				// Without them a model says an event "has no notes" about what to bring.
				...(notes && { notes }),
				tags: o.tags,
				// Flags only when set: most events are neither, and every field costs tokens.
				...(o.recurring && { recurring: true as const }),
				...(o.source !== null && { external: true as const }),
				// Other days are before or after today by their date; the model needs this only
				// to tell what is over from what is still to come today.
				...((date === today || when === 'now') && { when }),
			};
		};
		return {
			events: all.slice(0, MAX_FOUND).map(view),
			truncated: all.length > MAX_FOUND,
			...(forOthers.length > 0 && { forOthers: forOthers.map(view) }),
			...(unmatched.length > 0 && { unmatched: unmatched.map(view) }),
			...(nextMatch && { nextMatch }),
			...(notes.length > 0 && { note: notes.join(' ') }),
		};
	},
});
