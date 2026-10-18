import {
	type DigestItem,
	defineDigest,
	digestForPeople,
	digestNotes,
	digestOf,
	type UnitOfWork,
} from '@famos/sdk';
import { addDays, todayIn, zoned } from '@famos/time';
import { eventHref, type Occurrence } from '../contract/index.ts';
import { calendarView } from './capabilities.ts';
import { occurrencesBetween, sortOccurrences } from './store.ts';
import { externalOccurrencesBetween } from './subscriptions.ts';
import { whenOf } from './when.ts';

/** How far past the span the digest looks for the next event, in steps of `NEXT_STEP_DAYS`. */
const NEXT_DAYS = 366;
const NEXT_STEP_DAYS = 31;

const clock = (ms: number, timeZone: string) =>
	zoned(ms, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });
const dayOf = (ms: number, timeZone: string) => zoned(ms, timeZone).toPlainDate().toString();

/** One occurrence as a digest item: the day it starts on, its time, its end, notes and place. */
export function eventItem(o: Occurrence, now: number, today: string, timeZone: string): DigestItem {
	const date = o.allDay ? (o.startDate as string) : dayOf(o.start as number, timeZone);
	const when = whenOf(o, now, today);
	let end: DigestItem['end'];
	if (o.allDay) {
		if (o.endDate && o.endDate !== o.startDate) end = { date: o.endDate };
	} else if (o.end !== null && o.end !== o.start) {
		const endDay = dayOf(o.end, timeZone);
		end = { ...(endDay !== date && { date: endDay }), time: clock(o.end, timeZone) };
	}
	const notes = digestNotes(o.notes);
	const extra: Record<string, string> = {
		...(o.location && { location: o.location }),
		...(o.tags.length > 0 && { tags: o.tags.join(', ') }),
		// One date of a repeating event, for changing only that one.
		...(o.recurring && o.source === null && { occurrence: o.key }),
		...(o.source !== null && { calendar: o.source.name }),
	};
	return {
		handle: o.source === null ? o.eventId : null,
		kind: 'event',
		title: o.title,
		date,
		...(!o.allDay && { time: clock(o.start as number, timeZone) }),
		...(end && { end }),
		...(o.allDay && { allDay: true }),
		people: o.memberIds,
		...(notes && { notes }),
		// Only today's events say where they stand; other days are before or after by their date.
		...((date === today || when === 'now') && { status: when }),
		...(Object.keys(extra).length > 0 && { extra }),
		// A subscribed calendar's event has no page of its own.
		...(o.source === null && { href: eventHref(o.eventId, date) }),
	};
}

async function occurrences(
	uow: UnitOfWork,
	from: string,
	to: string,
	timeZone: string,
	memberIds: readonly string[] | undefined,
) {
	const [own, external] = await Promise.all([
		occurrencesBetween(uow.db, from, to, timeZone, { withNotes: true }),
		externalOccurrencesBetween(uow.db, from, to, timeZone),
	]);
	return sortOccurrences([...own, ...external], timeZone).filter((o) =>
		digestForPeople(o.memberIds, memberIds),
	);
}

/**
 * What is on the calendar in a span, notes included, repeating events expanded and subscribed
 * calendars in it. An event for the whole family counts for everyone asked about.
 */
export const calendarDigest = defineDigest({
	id: 'calendar.digest',
	topic: 'calendar',
	title: 'What is on the calendar in some days, for an answer',
	description:
		'The events between two days, in time order, with their notes, place and the people they are for; events for the whole family count for everyone.',
	requires: calendarView.id,
	async run(uow, input) {
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const today = todayIn(timeZone, now);
		const item = (o: Occurrence) => eventItem(o, now, today, timeZone);
		const found = await occurrences(uow, input.from, input.to, timeZone, input.memberIds);
		return digestOf(found.map(item), input, {
			async next() {
				for (let start = 1; start <= NEXT_DAYS; start += NEXT_STEP_DAYS) {
					const from = addDays(input.to, start);
					const to = addDays(input.to, Math.min(start + NEXT_STEP_DAYS - 1, NEXT_DAYS));
					const [first] = await occurrences(uow, from, to, timeZone, input.memberIds);
					if (first) return item(first);
				}
				return null;
			},
		});
	},
});
