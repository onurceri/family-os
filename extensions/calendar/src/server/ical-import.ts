import { createHash } from 'node:crypto';
import {
	addDays,
	epochOf,
	expandDates,
	expandTimed,
	isValidTimeZone,
	Temporal,
	todayIn,
	zoned,
} from '@famos/time';
import ICAL from 'ical.js';
import { normalizeTags } from '../contract/index.ts';

/**
 * Reads an external iCalendar feed into our own event rows. Pure: no database, no
 * network. A series keeps its RRULE and exclusions and is expanded later by the same code as the
 * family's events; an override (RECURRENCE-ID) becomes its own row and its original occurrence is
 * excluded from the series; a cancelled override only excludes.
 *
 * A rule our expansion cannot handle is expanded here with ical.js into single events instead,
 * for the window around `now` (`EXPAND_PAST_DAYS` back, `EXPAND_AHEAD_DAYS` ahead, at most
 * `EXPAND_MAX` of them). Such events stop appearing beyond the window until a later refresh moves
 * it. A series in a time zone we cannot name (only the feed's own VTIMEZONE) is expanded the same way.
 *
 * `RECURRENCE-ID;RANGE=THISANDFUTURE` changes an occurrence and every later one. A single such
 * override splits the series: the master's rule ends just before it (UNTIL) and the override
 * starts a new series with the master's rule (COUNT reduced by what the first part used), or its
 * own rule when it has one. Exclusions after the split follow the shifted times; with its own rule
 * they are dropped. Cases that cannot be written this way are expanded into single events instead
 * (the ical.js path above): several such overrides on one series, a move to another weekday when
 * the rule names days (BYDAY, BYMONTHDAY …), a changed time of day when the rule names hours, a
 * zone we cannot name, an override past the end of the series. On that path a later occurrence is
 * shifted by the same distance in absolute time as the override moved its own (so across a DST
 * change the clock time can differ by an hour), or dropped when the override is cancelled.
 */

export class NotCalendarError extends Error {
	constructor() {
		super('not_calendar');
		this.name = 'NotCalendarError';
	}
}

export class TooManyEventsError extends Error {
	constructor() {
		super('too_large');
		this.name = 'TooManyEventsError';
	}
}

export interface ParsedEvent {
	uid: string;
	/** '' for the series (or a plain event); the original start of an override. */
	recurrenceKey: string;
	title: string;
	location: string | null;
	notes: string | null;
	allDay: boolean;
	startsAt: number | null;
	endsAt: number | null;
	startDate: string | null;
	/** Inclusive. */
	endDate: string | null;
	timeZone: string;
	rrule: string | null;
	/** Epoch ms (timed) or YYYY-MM-DD (all-day). */
	exdates: (string | number)[];
	/** The feed's CATEGORIES, cleaned like the family's own tags. */
	tags: string[];
	fingerprint: string;
}

type Time = InstanceType<typeof ICAL.Time>;
type Component = InstanceType<typeof ICAL.Component>;
type IcalEvent = InstanceType<typeof ICAL.Event>;

export const MAX_EVENTS = 5000;
const EXPAND_PAST_DAYS = 31;
const EXPAND_AHEAD_DAYS = 400;
const EXPAND_MAX = 800;
/**
 * Steps one series may take through ical.js, counting the ones before the window. A daily event
 * since 1990 needs about 13,000; a rule finer than that (every second from 1970) would take
 * millions and is the shape of an attack, not a calendar.
 */
const EXPAND_MAX_STEPS = 30_000;
/** Seconds in one step of each rule frequency finer than a day; coarser ones cannot run away. */
const FINE_STEP_SECONDS: Record<string, number> = { SECONDLY: 1, MINUTELY: 60, HOURLY: 3600 };
/** Wall time one series may take. The process is single-threaded, so nothing else can run meanwhile. */
const EXPAND_MAX_MS = 3000;
const DAY = 86_400_000;

const clip = (value: string | null | undefined, max: number) => {
	const text = (value ?? '').trim();
	return text === '' ? null : text.slice(0, max);
};

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Calendar apps also use names like "W. Europe Standard Time"; those are not IANA. */
const isIana = (tzid: string) =>
	/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tzid) && isValidTimeZone(tzid);

interface Moment {
	/** A date (all-day) or an instant. */
	date: string | null;
	ms: number | null;
	/** IANA zone of the wall clock; null when the zone is unknown (the instant is still right). */
	zone: string | null;
}

/** An ICAL.Time as a date or an instant; floating times mean the family's wall clock. */
function moment(time: Time, familyZone: string): Moment {
	if (time.isDate)
		return {
			date: `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`,
			ms: null,
			zone: null,
		};
	const tzid = time.zone?.tzid ?? 'floating';
	const date = `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;
	const clock = `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
	if (tzid === 'UTC' || tzid === 'Z')
		return { date: null, ms: epochOf(date, clock, 'UTC'), zone: 'UTC' };
	if (tzid === 'floating')
		return { date: null, ms: epochOf(date, clock, familyZone), zone: familyZone };
	if (isIana(tzid)) return { date: null, ms: epochOf(date, clock, tzid), zone: tzid };
	// A zone defined only by the feed's own VTIMEZONE: ical.js knows its offsets.
	return { date: null, ms: time.toUnixTime() * 1000, zone: null };
}

/** The key an occurrence has on a series of the given kind (epoch ms, or YYYY-MM-DD for all-day). */
function occurrenceKey(m: Moment, allDay: boolean, familyZone: string): string | number {
	if (allDay) return m.date ?? todayIn(familyZone, m.ms as number);
	return m.date ? epochOf(m.date, '00:00', familyZone) : (m.ms as number);
}

const timesOf = (component: Component, name: string): Time[] =>
	component
		.getAllProperties(name)
		.flatMap((p) => p.getValues())
		.filter((v): v is Time => v instanceof ICAL.Time);

/** CATEGORIES may repeat and hold several values each. */
const categoriesOf = (component: Component): string[] =>
	normalizeTags(
		component
			.getAllProperties('categories')
			.flatMap((p) => p.getValues())
			.map(String),
	);

const isCancelled = (component: Component) =>
	String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';

interface Source {
	component: Component;
	event: IcalEvent;
}

type Row = Omit<ParsedEvent, 'fingerprint'>;

const isThisAndFuture = (s: Source) =>
	String(
		s.component.getFirstProperty('recurrence-id')?.getParameter('range') ?? '',
	).toUpperCase() === 'THISANDFUTURE';

const compact = (date: string) => date.replaceAll('-', '');

/** The rule with COUNT and UNTIL replaced by the given end (or none). */
function withEnd(rrule: string, end: { until?: string; count?: number }): string {
	const parts = rrule.split(';').filter((p) => !/^(COUNT|UNTIL)=/i.test(p));
	if (end.until) parts.push(`UNTIL=${end.until}`);
	if (end.count !== undefined) parts.push(`COUNT=${end.count}`);
	return parts.join(';');
}

const ruleCount = (rrule: string): number | null => {
	const m = /(?:^|;)COUNT=(\d+)/i.exec(rrule);
	return m ? Number(m[1]) : null;
};

/** The UTC form of the instant just before `ms`, as an UNTIL value. */
const untilBefore = (ms: number) =>
	Temporal.Instant.fromEpochMilliseconds(ms - 1000)
		.toString({ fractionalSecondDigits: 0 })
		.replace(/[-:]/g, '');

/** One VEVENT as a row, without series information. */
function plainRow(s: Source, familyZone: string): Omit<ParsedEvent, 'fingerprint'> | null {
	const startTime = s.event.startDate;
	if (!startTime) return null;
	const start = moment(startTime, familyZone);
	const hasEnd = s.component.hasProperty('dtend') || s.component.hasProperty('duration');
	const endTime = hasEnd ? s.event.endDate : null;
	const common = {
		uid: s.event.uid,
		recurrenceKey: '',
		title: clip(s.event.summary, 300) ?? '—',
		location: clip(s.event.location, 300),
		notes: clip(s.event.description, 4000),
		tags: categoriesOf(s.component),
		rrule: null,
		exdates: [],
	};
	if (start.date) {
		const first = start.date;
		let last = first;
		if (endTime) {
			const end = moment(endTime, familyZone);
			// DTEND of a date event is exclusive; ours is the last day.
			const exclusive = end.date ?? first;
			last = exclusive > addDays(first, 1) ? addDays(exclusive, -1) : first;
		}
		return {
			...common,
			allDay: true,
			startsAt: null,
			endsAt: null,
			startDate: first,
			endDate: last,
			timeZone: familyZone,
		};
	}
	const startMs = start.ms as number;
	let endMs = startMs;
	if (endTime) {
		const end = moment(endTime, familyZone);
		endMs = end.ms === null ? startMs : Math.max(startMs, end.ms);
	}
	return {
		...common,
		allDay: false,
		startsAt: startMs,
		endsAt: endMs,
		startDate: null,
		endDate: null,
		timeZone: start.zone ?? 'UTC',
	};
}

/** Whether our own expansion copes with the series (it may throw on unusual rules). */
function representable(row: Omit<ParsedEvent, 'fingerprint'>): boolean {
	if (!row.rrule) return true;
	// Non-Gregorian calendars (RSCALE) would silently expand as Gregorian.
	if (/RSCALE=(?!GREGORIAN)/i.test(row.rrule)) return false;
	try {
		if (row.allDay) {
			const date = row.startDate as string;
			expandDates({ date, rrule: row.rrule }, date, addDays(date, 800));
		} else {
			const start = row.startsAt as number;
			expandTimed(
				{ startsAt: start, timeZone: row.timeZone, rrule: row.rrule },
				start,
				start + 800 * DAY,
			);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * `onSkipped` hears of each series left out because its rule cannot be expanded within bounds; the
 * rest of the feed is still read.
 */
export function parseCalendar(
	text: string,
	familyZone: string,
	now: number,
	onSkipped: (uid: string, reason: 'rule_too_dense') => void = () => {},
): ParsedEvent[] {
	let root: Component;
	try {
		root = new ICAL.Component(ICAL.parse(text));
	} catch {
		throw new NotCalendarError();
	}
	if (root.name !== 'vcalendar') throw new NotCalendarError();
	try {
		for (const vtz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(vtz);
		return readEvents(root, familyZone, now, onSkipped);
	} finally {
		ICAL.TimezoneService.reset();
	}
}

function readEvents(
	root: Component,
	familyZone: string,
	now: number,
	onSkipped: (uid: string, reason: 'rule_too_dense') => void,
): ParsedEvent[] {
	const masters = new Map<string, Source>();
	const overrides = new Map<string, Source[]>();
	for (const component of root.getAllSubcomponents('vevent')) {
		const event = new ICAL.Event(component);
		if (!event.uid || !component.hasProperty('dtstart')) continue;
		const source = { component, event };
		if (component.hasProperty('recurrence-id')) {
			overrides.set(event.uid, [...(overrides.get(event.uid) ?? []), source]);
		} else {
			masters.set(event.uid, source);
		}
	}

	const out = new Map<string, Omit<ParsedEvent, 'fingerprint'>>();
	const add = (row: Omit<ParsedEvent, 'fingerprint'>) =>
		out.set(`${row.uid}\u0000${row.recurrenceKey}`, row);

	/** An override whose series is missing or cancelled: it still happens, as a plain event. */
	function standalone(o: Source) {
		const rid = o.event.recurrenceId;
		const row = plainRow(o, familyZone);
		if (isCancelled(o.component) || !row || !rid) return;
		add({
			...row,
			recurrenceKey: String(occurrenceKey(moment(rid, familyZone), row.allDay, familyZone)),
		});
	}

	/**
	 * The series split at a THISANDFUTURE override: the part before it, and a new series from it.
	 * Null when that cannot be written cleanly (see the note at the top).
	 */
	function splitSeries(row: Row, o: Source): Row[] | null {
		const rid = o.event.recurrenceId;
		const rule = row.rrule;
		const over = plainRow(o, familyZone);
		if (!rid || !rule || !over || over.allDay !== row.allDay) return null;
		if (!row.allDay && moment(o.event.startDate, familyZone).zone === null) return null;
		const key = occurrenceKey(moment(rid, familyZone), row.allDay, familyZone);
		const start = (row.allDay ? row.startDate : row.startsAt) as string | number;
		if (key < start) return null;

		// What the part before the override uses up (for COUNT), without any exclusions.
		let before = 0;
		if (key > start) {
			before = row.allDay
				? expandDates(
						{ date: row.startDate as string, rrule: rule },
						row.startDate as string,
						addDays(key as string, -1),
					).length
				: expandTimed(
						{ startsAt: row.startsAt as number, timeZone: row.timeZone, rrule: rule },
						row.startsAt as number,
						key as number,
					).length;
		}
		const count = ruleCount(rule);
		if (count !== null && before >= count) return null;

		const out: Row[] = [];
		if (before > 0) {
			out.push({
				...row,
				rrule: withEnd(rule, {
					until: row.allDay ? compact(addDays(key as string, -1)) : untilBefore(key as number),
				}),
				exdates: row.exdates.filter((e) => e < key),
			});
		}
		if (!isCancelled(o.component)) {
			const ownRule = o.component.getFirstPropertyValue('rrule');
			let tailRule: string;
			let dayShift = 0;
			let clockShift = false;
			if (row.allDay) {
				dayShift = Math.round(
					(Date.parse(over.startDate as string) - Date.parse(key as string)) / DAY,
				);
			} else {
				const was = zoned(key as number, row.timeZone);
				const now = zoned(over.startsAt as number, over.timeZone);
				dayShift = Math.round(
					(Date.parse(now.toPlainDate().toString()) - Date.parse(was.toPlainDate().toString())) /
						DAY,
				);
				clockShift = now.toPlainTime().toString() !== was.toPlainTime().toString();
			}
			if (ownRule) {
				tailRule = String(ownRule);
			} else {
				if (dayShift !== 0 && /(?:^|;)BY(DAY|MONTHDAY|MONTH|YEARDAY|WEEKNO|SETPOS)=/i.test(rule))
					return null;
				if (clockShift && /(?:^|;)BY(HOUR|MINUTE|SECOND)=/i.test(rule)) return null;
				tailRule = count === null ? rule : withEnd(rule, { count: count - before });
			}
			// Exclusions after the split follow the series to its new times; a new rule starts clean.
			const exdates = ownRule
				? []
				: row.exdates
						.filter((e) => e > key)
						.map((e) => {
							if (row.allDay) return addDays(e as string, dayShift);
							const day = zoned(e as number, row.timeZone)
								.toPlainDate()
								.add({ days: dayShift });
							const at = zoned(over.startsAt as number, over.timeZone)
								.toPlainTime()
								.toString();
							return epochOf(day.toString(), at, over.timeZone);
						});
			out.push({ ...over, recurrenceKey: `>${key}`, rrule: tailRule, exdates });
		}
		return out.every(representable) ? out : null;
	}

	/** The series as single events in the window around `now`. */
	function expandWithIcal(s: Source, row: Row, future: Source[] = []) {
		const from = now - EXPAND_PAST_DAYS * DAY;
		const to = now + EXPAND_AHEAD_DAYS * DAY;
		const skipped = new Set(row.exdates.map(String));
		const spanMs = row.allDay ? 0 : (row.endsAt as number) - (row.startsAt as number);
		const spanDays = row.allDay
			? Math.round((Date.parse(row.endDate as string) - Date.parse(row.startDate as string)) / DAY)
			: 0;
		// THISANDFUTURE overrides by the original occurrence they start at, earliest first.
		const changes = future
			.flatMap((o) => {
				const rid = o.event.recurrenceId;
				const over = plainRow(o, familyZone);
				if (!rid) return [];
				const key = occurrenceKey(moment(rid, familyZone), row.allDay, familyZone);
				return [{ key, over: isCancelled(o.component) ? null : over }];
			})
			.sort((a, b) => (a.key < b.key ? -1 : 1));
		// Counting the steps to the window beforehand skips a hopeless rule without spending any.
		const rule = s.component.getFirstPropertyValue('rrule');
		const stepSeconds = FINE_STEP_SECONDS[String((rule as { freq?: string } | null)?.freq)];
		const interval = Number((rule as { interval?: number } | null)?.interval) || 1;
		const first = s.event.startDate.toUnixTime() * 1000;
		if (stepSeconds && (from - first) / 1000 / (stepSeconds * interval) > EXPAND_MAX_STEPS) {
			onSkipped(s.event.uid, 'rule_too_dense');
			return;
		}
		const iterator = s.event.iterator();
		const started = performance.now();
		const found: Omit<ParsedEvent, 'fingerprint'>[] = [];
		let count = 0;
		let steps = 0;
		for (let next = iterator.next(); next && count < EXPAND_MAX; next = iterator.next()) {
			// A rule that cannot reach the window in bounds is unrepresentable: none of it is kept.
			if (++steps > EXPAND_MAX_STEPS || performance.now() - started > EXPAND_MAX_MS) {
				onSkipped(s.event.uid, 'rule_too_dense');
				return;
			}
			const m = moment(next, familyZone);
			const at = m.date ? Date.parse(m.date) : (m.ms as number);
			if (at > to) break;
			if (at + spanMs + spanDays * DAY < from) continue;
			const key = occurrenceKey(m, row.allDay, familyZone);
			if (skipped.has(String(key))) continue;
			count++;
			const change = changes.findLast((c) => c.key <= key);
			if (change && !change.over) continue;
			const changed = change?.over ?? null;
			const single = {
				...row,
				...(changed
					? {
							title: changed.title,
							location: changed.location,
							notes: changed.notes,
							tags: changed.tags,
						}
					: {}),
				recurrenceKey: `~${key}`,
				rrule: null,
				exdates: [],
			};
			if (row.allDay) {
				const shift = changed
					? Math.round(
							(Date.parse(changed.startDate as string) - Date.parse(change?.key as string)) / DAY,
						)
					: 0;
				const first = addDays(m.date as string, shift);
				const days = changed
					? Math.round(
							(Date.parse(changed.endDate as string) - Date.parse(changed.startDate as string)) /
								DAY,
						)
					: spanDays;
				found.push({ ...single, startDate: first, endDate: addDays(first, days) });
			} else {
				const first = changed
					? (m.ms as number) + ((changed.startsAt as number) - (change?.key as number))
					: (m.ms as number);
				const span = changed ? (changed.endsAt as number) - (changed.startsAt as number) : spanMs;
				found.push({ ...single, startsAt: first, endsAt: first + span });
			}
		}
		for (const r of found) add(r);
	}

	for (const [uid, s] of masters) {
		const row = plainRow(s, familyZone);
		const mine = overrides.get(uid) ?? [];
		overrides.delete(uid);
		if (!row || isCancelled(s.component)) {
			for (const o of mine) standalone(o);
			continue;
		}
		const rule = s.component.getFirstPropertyValue('rrule');
		row.rrule = rule ? String(rule) : null;
		row.exdates = timesOf(s.component, 'exdate').map((t) =>
			occurrenceKey(moment(t, familyZone), row.allDay, familyZone),
		);
		// A THISANDFUTURE override only counts on a series that recurs.
		const future = row.rrule ? mine.filter(isThisAndFuture) : [];
		// Overrides replace their occurrence; a cancelled one only removes it.
		for (const o of mine) {
			if (future.includes(o)) continue;
			const rid = o.event.recurrenceId;
			if (!rid) continue;
			const key = occurrenceKey(moment(rid, familyZone), row.allDay, familyZone);
			row.exdates.push(key);
			const over = isCancelled(o.component) ? null : plainRow(o, familyZone);
			if (over) add({ ...over, recurrenceKey: String(key) });
		}
		const unnamedZone = !row.allDay && moment(s.event.startDate, familyZone).zone === null;
		if (future.length > 0) {
			const split =
				!unnamedZone && representable(row) && future.length === 1
					? splitSeries(row, future[0] as Source)
					: null;
			if (split) for (const part of split) add(part);
			else expandWithIcal(s, row, future);
		} else if (row.rrule && (unnamedZone || !representable(row))) expandWithIcal(s, row);
		else add(row);
	}
	for (const list of overrides.values()) for (const o of list) standalone(o);

	if (out.size > MAX_EVENTS) throw new TooManyEventsError();
	// Tags stay out of the fingerprint: it guards planned reminders, which tags do not affect.
	return [...out.values()].map((row) => {
		const { tags: _tags, ...content } = row;
		return {
			...row,
			fingerprint: createHash('sha1').update(JSON.stringify(content)).digest('hex').slice(0, 20),
		};
	});
}
