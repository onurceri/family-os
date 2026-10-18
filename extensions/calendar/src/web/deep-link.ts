import { EventIdSchema, type Occurrence } from '../contract/index.js';

/** An event the address asks to open (`/calendar?event=<id>&on=<day>`), and the day to show. */
export interface EventLink {
	eventId: string;
	/** The day the event is on (YYYY-MM-DD), or null when the address names none. */
	on: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The event the query asks for, or null when it names none or not a family event's id. */
export function eventLink(query: URLSearchParams): EventLink | null {
	const eventId = EventIdSchema.safeParse(query.get('event'));
	if (!eventId.success) return null;
	const on = query.get('on');
	return { eventId: eventId.data, on: on && ISO_DAY.test(on) ? on : null };
}

/**
 * The occurrence a link means among those loaded: the event's one on the day named, else its
 * first one (an event that moved since the link was made still opens), else none.
 */
export function occurrenceFor(
	occurrences: readonly Occurrence[],
	link: EventLink,
	covers: (occurrence: Occurrence, day: string) => boolean,
): Occurrence | null {
	const own = occurrences.filter((o) => o.eventId === link.eventId);
	const on = link.on;
	return (on ? own.find((o) => covers(o, on)) : undefined) ?? own[0] ?? null;
}
