import { Temporal } from '@famos/time';
import { describe, expect, it } from 'vitest';
import { isAsleep, isDark, nextChange, nextCheck, WAKE_MS, wakesAt, wokenAt } from './sleep.js';

const at = (iso: string, zone: string) =>
	Temporal.PlainDateTime.from(iso).toZonedDateTime(zone).epochMilliseconds;

const ZONE = 'Europe/Amsterdam';
const night = { from: '22:00', until: '07:00' };
const day = { from: '13:00', until: '15:30' };

describe('isAsleep', () => {
	it('is never asleep without a window', () => {
		expect(isAsleep(at('2026-03-10T03:00', ZONE), ZONE, null)).toBe(false);
	});

	it('follows a window inside one day', () => {
		expect(isAsleep(at('2026-03-10T12:59:59', ZONE), ZONE, day)).toBe(false);
		expect(isAsleep(at('2026-03-10T14:00', ZONE), ZONE, day)).toBe(true);
		expect(isAsleep(at('2026-03-10T15:31', ZONE), ZONE, day)).toBe(false);
	});

	it('follows a window across midnight', () => {
		expect(isAsleep(at('2026-03-10T21:59', ZONE), ZONE, night)).toBe(false);
		expect(isAsleep(at('2026-03-10T23:30', ZONE), ZONE, night)).toBe(true);
		expect(isAsleep(at('2026-03-11T00:00', ZONE), ZONE, night)).toBe(true);
		expect(isAsleep(at('2026-03-11T06:59:59', ZONE), ZONE, night)).toBe(true);
		expect(isAsleep(at('2026-03-11T12:00', ZONE), ZONE, night)).toBe(false);
	});

	it('is dark exactly at from and lit exactly at until', () => {
		expect(isAsleep(at('2026-03-10T22:00', ZONE), ZONE, night)).toBe(true);
		expect(isAsleep(at('2026-03-11T07:00', ZONE), ZONE, night)).toBe(false);
		expect(isAsleep(at('2026-03-10T13:00', ZONE), ZONE, day)).toBe(true);
		expect(isAsleep(at('2026-03-10T15:30', ZONE), ZONE, day)).toBe(false);
	});

	it('reads the clock in the family zone, not the device zone', () => {
		const instant = Date.UTC(2026, 2, 10, 22, 30);
		expect(isAsleep(instant, 'UTC', night)).toBe(true);
		expect(isAsleep(instant, 'Asia/Tokyo', night)).toBe(false);
	});

	it('follows the wall clock on a day the clocks change', () => {
		// Amsterdam, 2026-03-29: 02:00 became 03:00; 2026-10-25: 03:00 became 02:00.
		expect(isAsleep(at('2026-03-29T06:59', ZONE), ZONE, night)).toBe(true);
		expect(isAsleep(at('2026-03-29T07:00', ZONE), ZONE, night)).toBe(false);
		expect(isAsleep(at('2026-10-25T06:59', ZONE), ZONE, night)).toBe(true);
		expect(isAsleep(at('2026-10-25T07:00', ZONE), ZONE, night)).toBe(false);
		// The repeated hour of the autumn change is dark in both passes.
		const first = Date.parse('2026-10-25T00:30:00Z');
		const second = Date.parse('2026-10-25T01:30:00Z');
		const window = { from: '02:00', until: '03:00' };
		expect(isAsleep(first, ZONE, window)).toBe(true);
		expect(isAsleep(second, ZONE, window)).toBe(true);
	});
});

describe('nextChange', () => {
	it('is null without a window', () => {
		expect(nextChange(Date.now(), ZONE, null)).toBeNull();
	});

	it('finds the next start or end', () => {
		expect(nextChange(at('2026-03-10T12:00', ZONE), ZONE, night)).toBe(
			at('2026-03-10T22:00', ZONE),
		);
		expect(nextChange(at('2026-03-10T23:00', ZONE), ZONE, night)).toBe(
			at('2026-03-11T07:00', ZONE),
		);
		expect(nextChange(at('2026-03-11T08:00', ZONE), ZONE, night)).toBe(
			at('2026-03-11T22:00', ZONE),
		);
	});

	it('moves past the edge it is standing on', () => {
		expect(nextChange(at('2026-03-10T22:00', ZONE), ZONE, night)).toBe(
			at('2026-03-11T07:00', ZONE),
		);
	});

	it('counts in wall-clock time over a change of the clocks', () => {
		// The night of 2026-10-25 has an extra hour: 07:00 is eleven hours after 22:00 of the 24th.
		const next = nextChange(at('2026-10-24T22:00', ZONE), ZONE, night);
		expect(next).toBe(at('2026-10-25T07:00', ZONE));
		expect((next ?? 0) - at('2026-10-24T22:00', ZONE)).toBe(10 * 3_600_000);
	});
});

describe('waking by touch', () => {
	const now = at('2026-03-10T23:00', ZONE);

	it('is black inside the window until someone touches it', () => {
		expect(isDark(now, ZONE, night, null)).toBe(true);
		expect(isDark(now, ZONE, null, null)).toBe(false);
		expect(isDark(at('2026-03-10T12:00', ZONE), ZONE, night, null)).toBe(false);
	});

	it('wakes for a minute after a touch and then goes black again', () => {
		const awake = wokenAt(now);
		expect(awake - now).toBe(WAKE_MS);
		expect(isDark(now + 1000, ZONE, night, awake)).toBe(false);
		expect(isDark(now + WAKE_MS - 1, ZONE, night, awake)).toBe(false);
		expect(isDark(now + WAKE_MS, ZONE, night, awake)).toBe(true);
	});

	it('stays lit outside the window whatever the touch says', () => {
		expect(isDark(at('2026-03-11T07:00', ZONE), ZONE, night, null)).toBe(false);
	});

	it('looks again at the end of a wake when that comes before the window changes', () => {
		const awake = wokenAt(now);
		expect(nextCheck(now, ZONE, night, awake)).toBe(awake);
		expect(nextCheck(now, ZONE, night, null)).toBe(at('2026-03-11T07:00', ZONE));
		expect(nextCheck(now, ZONE, null, awake)).toBeNull();
		// A wake that ended long ago does not count.
		expect(nextCheck(now, ZONE, night, now - 5000)).toBe(at('2026-03-11T07:00', ZONE));
	});
});

describe('wakesAt', () => {
	it('is the next time the window ends', () => {
		expect(wakesAt(at('2026-03-10T23:00', ZONE), ZONE, night)).toBe(at('2026-03-11T07:00', ZONE));
	});
});
