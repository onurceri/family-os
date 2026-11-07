import { isNightHour } from '@famos/time';

/** What a device follows for day and night: the system, a fixed look, or the time of day. */
export type Mode = 'system' | 'day' | 'night' | 'time';

export const MODES: readonly Mode[] = ['system', 'day', 'night', 'time'];

/** The choice kept in this browser, if it is one of the modes (the system is never stored). */
export function parseMode(value: string | null): Mode | null {
	return value === 'day' || value === 'night' || value === 'time' ? value : null;
}

/**
 * The mode a device uses when its person has not chosen: family displays follow the time of
 * day (a wall frame never switches its system to dark), every other device the system.
 */
export function defaultMode(display: boolean): Mode {
	return display ? 'time' : 'system';
}

/**
 * Whether to draw the night palette at `now`. `time` is night from `NIGHT_FROM_HOUR` until
 * `DAY_FROM_HOUR` in `timeZone` (the hours `isNightHour` uses). app.html repeats those two
 * hours for the first paint and must match them.
 */
export function isNight(mode: Mode, now: number, timeZone: string, systemDark: boolean): boolean {
	if (mode === 'night') return true;
	if (mode === 'system') return systemDark;
	if (mode === 'time') return isNightHour(now, timeZone);
	return false;
}
