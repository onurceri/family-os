import { describe, expect, it } from 'vitest';
import { parseCalendar } from '../src/server/ical-import.ts';

const TZ = 'Europe/Berlin';
const NOW = Date.parse('2026-10-14T12:00:00Z');

// A zone only the feed defines is expanded by ical.js, the path that needs bounding.
const zone = [
	'BEGIN:VTIMEZONE',
	'TZID:Feed Own Zone',
	'BEGIN:STANDARD',
	'DTSTART:19700101T000000',
	'TZOFFSETFROM:+0100',
	'TZOFFSETTO:+0100',
	'END:STANDARD',
	'END:VTIMEZONE',
];

const feed = (...events: string[][]) =>
	[
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//t//t//EN',
		...zone,
		...events.flat(),
		'END:VCALENDAR',
	].join('\r\n');

const series = (uid: string, start: string, rule: string, tzid = 'Feed Own Zone') => [
	'BEGIN:VEVENT',
	`UID:${uid}`,
	'DTSTAMP:20260101T000000Z',
	`DTSTART;TZID=${tzid}:${start}`,
	`DTEND;TZID=${tzid}:${start.replace(/T\d{6}/, 'T010000')}`,
	`RRULE:${rule}`,
	'SUMMARY:Series',
	'END:VEVENT',
];

describe('expanding a subscribed feed', () => {
	it('skips a rule that cannot reach the window in bounds and keeps the rest', () => {
		const skipped: string[] = [];
		const text = feed(
			series('dense', '19700101T000000', 'FREQ=SECONDLY'),
			series('fine', '20260101T080000', 'FREQ=DAILY;COUNT=400'),
		);
		const started = performance.now();
		const parsed = parseCalendar(text, TZ, NOW, (uid, reason) => skipped.push(`${uid}:${reason}`));
		expect(performance.now() - started).toBeLessThan(1000);
		expect(skipped).toEqual(['dense:rule_too_dense']);
		expect(parsed.some((p) => p.uid === 'dense')).toBe(false);
		expect(parsed.some((p) => p.uid === 'fine')).toBe(true);
	});

	it('still expands a daily rule that began in 1990', () => {
		const skipped: string[] = [];
		const text = feed(series('old', '19900101T080000', 'FREQ=DAILY'));
		const parsed = parseCalendar(text, TZ, NOW, (uid) => skipped.push(uid));
		expect(skipped).toEqual([]);
		const days = parsed.filter((p) => p.uid === 'old');
		expect(days.length).toBeGreaterThan(7);
		const week = days.filter(
			(p) => (p.startsAt as number) >= NOW && (p.startsAt as number) < NOW + 7 * 86_400_000,
		);
		expect(week.length).toBeGreaterThanOrEqual(6);
	});
});
