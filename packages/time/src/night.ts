import { HOUR_MS } from './dates.ts';

/** The sun's day at the place: up from `rise` until `set` (epoch ms). */
export interface SunDay {
	rise: number;
	set: number;
}

/** Without sunrise and sunset, the hours from 06:00 until 20:00 local are day. */
export const DAY_FROM_HOUR = 6;
export const NIGHT_FROM_HOUR = 20;
const HALF_HOUR_MS = HOUR_MS / 2;

/**
 * Whether an hour is night: a moon in the forecast strip, the night palette by time of day. Judged at
 * the middle of the hour: against the sun's days when the forecast has them, otherwise by the
 * hour in the family's time zone (day from `DAY_FROM_HOUR` until `NIGHT_FROM_HOUR`).
 */
export function isNightHour(at: number, timeZone: string, sun?: readonly SunDay[]): boolean {
	const mid = at + HALF_HOUR_MS;
	if (sun && sun.length > 0) return !sun.some((d) => mid >= d.rise && mid < d.set);
	const hour = Number(
		new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(at),
	);
	return hour < DAY_FROM_HOUR || hour >= NIGHT_FROM_HOUR;
}
