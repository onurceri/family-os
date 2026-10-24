import { addDays, DAY_MS, Temporal, zoned } from '@famos/time';
import { type EventRow, tagsOf } from './store.ts';

/**
 * Writes the family's events as an iCalendar feed (RFC 5545) for phones and other calendars.
 * One-off timed events are written in UTC; repeating timed events keep their time zone (with a
 * VTIMEZONE), so "every Tuesday 17:30" stays at 17:30 across daylight saving changes.
 */

const CRLF = '\r\n';
const encoder = new TextEncoder();

/** TEXT values: backslash, semicolon, comma and line breaks are escaped (RFC 5545 §3.3.11). */
export function escapeText(value: string): string {
	return value
		.replace(/\r\n|\r|\n/g, '\n')
		.replace(/[\\;,]/g, (c) => `\\${c}`)
		.replace(/\n/g, '\\n');
}

/** Folds a content line at 75 octets, never inside a UTF-8 character (RFC 5545 §3.1). */
export function foldLine(line: string): string {
	if (encoder.encode(line).length <= 75) return line;
	const parts: string[] = [];
	let current = '';
	let size = 0;
	// Continuation lines start with a space, which counts toward their 75 octets.
	let limit = 75;
	for (const char of line) {
		const bytes = encoder.encode(char).length;
		if (size + bytes > limit) {
			parts.push(current);
			current = ' ';
			size = 1;
			limit = 75;
		}
		current += char;
		size += bytes;
	}
	parts.push(current);
	return parts.join(CRLF);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const utcStamp = (ms: number) => {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

const localStamp = (ms: number, timeZone: string) => {
	const z = zoned(ms, timeZone);
	return `${pad(z.year, 4)}${pad(z.month)}${pad(z.day)}T${pad(z.hour)}${pad(z.minute)}${pad(z.second)}`;
};

const dateStamp = (date: string) => date.replaceAll('-', '');

const offsetText = (ns: number) => {
	const minutes = Math.round(ns / 60_000_000_000);
	const sign = minutes < 0 ? '-' : '+';
	const abs = Math.abs(minutes);
	return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
};

/** A VTIMEZONE with explicit observances for the transitions between two instants. */
export function vtimezone(timeZone: string, fromMs: number, toMs: number): string[] {
	const first = zoned(fromMs, timeZone);
	const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`];
	const observance = (
		kind: 'STANDARD' | 'DAYLIGHT',
		start: string,
		from: number,
		to: number,
		name: string,
	) => {
		lines.push(
			`BEGIN:${kind}`,
			`DTSTART:${start}`,
			`TZOFFSETFROM:${offsetText(from)}`,
			`TZOFFSETTO:${offsetText(to)}`,
			`TZNAME:${name}`,
			`END:${kind}`,
		);
	};
	const nameOf = (ms: number) =>
		new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'short' })
			.formatToParts(ms)
			.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
	observance(
		'STANDARD',
		'19700101T000000',
		first.offsetNanoseconds,
		first.offsetNanoseconds,
		nameOf(fromMs),
	);
	let cursor: Temporal.ZonedDateTime | null = first;
	for (let i = 0; i < 80 && cursor; i++) {
		const next: Temporal.ZonedDateTime | null = cursor.getTimeZoneTransition('next');
		if (!next || next.epochMilliseconds > toMs) break;
		const before = next.subtract({ milliseconds: 1 });
		const start = Temporal.Instant.fromEpochMilliseconds(next.epochMilliseconds)
			.toZonedDateTimeISO('UTC')
			.add({ nanoseconds: before.offsetNanoseconds });
		const stamp = `${pad(start.year, 4)}${pad(start.month)}${pad(start.day)}T${pad(start.hour)}${pad(start.minute)}${pad(start.second)}`;
		observance(
			next.offsetNanoseconds > before.offsetNanoseconds ? 'DAYLIGHT' : 'STANDARD',
			stamp,
			before.offsetNanoseconds,
			next.offsetNanoseconds,
			nameOf(next.epochMilliseconds),
		);
		cursor = next;
	}
	lines.push('END:VTIMEZONE');
	return lines;
}

const jsonList = (value: string | null): (string | number)[] => (value ? JSON.parse(value) : []);

/** A date moved out of a series, written as an override of the series' own occurrence. */
type Override = { series: EventRow; key: string };

/** RECURRENCE-ID of an override: the replaced occurrence, in the series' own zone (§3.8.4.4). */
function recurrenceId({ series, key }: Override): string {
	if (series.all_day) return `RECURRENCE-ID;VALUE=DATE:${dateStamp(key)}`;
	return `RECURRENCE-ID;TZID=${series.time_zone}:${localStamp(Number(key), series.time_zone)}`;
}

/**
 * The content lines of one VEVENT. A date moved out of a series (`override`) carries the series'
 * UID and a RECURRENCE-ID, so a calendar app shows it as that series' date moved, not as a second
 * event. `overridden` holds the occurrence keys of a series that have an override: an EXDATE for
 * the same occurrence would contradict it, so they are left out of the series' EXDATE.
 */
export function eventLines(
	row: EventRow,
	includeNotes: boolean,
	override?: Override,
	overridden?: ReadonlySet<string>,
): string[] {
	const lines = ['BEGIN:VEVENT', `UID:${(override?.series ?? row).id}@familyos`];
	lines.push(`DTSTAMP:${utcStamp(row.updated_at)}`, `LAST-MODIFIED:${utcStamp(row.updated_at)}`);
	if (override) lines.push(recurrenceId(override));
	const exdates = jsonList(row.exdates).filter((e) => !overridden?.has(String(e)));
	if (row.all_day) {
		const start = row.start_date as string;
		const end = row.end_date ?? start;
		lines.push(`DTSTART;VALUE=DATE:${dateStamp(start)}`);
		// DTEND of a date event is exclusive.
		lines.push(`DTEND;VALUE=DATE:${dateStamp(addDays(end, 1))}`);
		if (row.rrule) lines.push(`RRULE:${row.rrule}`);
		if (exdates.length)
			lines.push(`EXDATE;VALUE=DATE:${exdates.map((d) => dateStamp(String(d))).join(',')}`);
	} else {
		const start = row.starts_at as number;
		const end = row.ends_at as number;
		if (row.rrule) {
			const tz = row.time_zone;
			lines.push(
				`DTSTART;TZID=${tz}:${localStamp(start, tz)}`,
				`DTEND;TZID=${tz}:${localStamp(end, tz)}`,
			);
			lines.push(`RRULE:${row.rrule}`);
			if (exdates.length)
				lines.push(
					`EXDATE;TZID=${tz}:${exdates.map((ms) => localStamp(Number(ms), tz)).join(',')}`,
				);
		} else {
			lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`);
		}
	}
	lines.push(`SUMMARY:${escapeText(row.title)}`);
	if (row.location) lines.push(`LOCATION:${escapeText(row.location)}`);
	const tags = tagsOf(row.tags);
	if (tags.length) lines.push(`CATEGORIES:${tags.map(escapeText).join(',')}`);
	if (includeNotes && row.notes) lines.push(`DESCRIPTION:${escapeText(row.notes)}`);
	lines.push('END:VEVENT');
	return lines;
}

/** A whole VCALENDAR. `now` anchors the time zone rules of repeating timed events. */
export function buildCalendar(
	name: string,
	rows: readonly EventRow[],
	options: { includeNotes: boolean; now: number },
): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//FamilyOS//Calendar//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${escapeText(name)}`,
		'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		'X-PUBLISHED-TTL:PT1H',
	];
	// One VTIMEZONE per zone used by a repeating timed event, from the series' start to ten years out.
	const zones = new Map<string, number>();
	for (const row of rows) {
		if (row.all_day || !row.rrule) continue;
		const start = Math.min(row.starts_at as number, options.now);
		zones.set(row.time_zone, Math.min(zones.get(row.time_zone) ?? start, start));
	}
	const horizon = options.now + 10 * 365 * DAY_MS;
	for (const [tz, from] of zones) lines.push(...vtimezone(tz, from, horizon));
	// A moved date is an override only while its series is in the feed too (the feed of one member
	// may hold the date and not the series); otherwise it is an event of its own.
	const byId = new Map(rows.map((r) => [r.id, r]));
	const seriesOf = (row: EventRow): Override | undefined => {
		const series = row.series_id ? byId.get(row.series_id) : undefined;
		return series?.rrule && row.recurrence_key !== null && !row.rrule
			? { series, key: row.recurrence_key }
			: undefined;
	};
	const overridden = new Map<string, Set<string>>();
	for (const row of rows) {
		const o = seriesOf(row);
		if (o) overridden.set(o.series.id, (overridden.get(o.series.id) ?? new Set()).add(o.key));
	}
	for (const row of rows)
		lines.push(...eventLines(row, options.includeNotes, seriesOf(row), overridden.get(row.id)));
	lines.push('END:VCALENDAR');
	return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
