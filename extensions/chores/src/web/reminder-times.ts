import { formatClock, IsoTimeSchema } from '@famos/time';
import { LEFT_TODAY_MAX_TIMES } from '../contract/index.js';

/** Whether the list in the form may be saved: one to four different, valid times of day. */
export function timesProblem(times: string[]): 'empty' | 'invalid' | 'duplicate' | null {
	if (times.length === 0) return 'empty';
	if (times.some((time) => !IsoTimeSchema.safeParse(time).success)) return 'invalid';
	if (new Set(times).size !== times.length) return 'duplicate';
	return null;
}

export const mayAddTime = (times: string[]): boolean => times.length < LEFT_TODAY_MAX_TIMES;

/** A time to offer for a new row: the first full hour after the last one that is not listed. */
export function nextTime(times: string[]): string {
	const last = [...times].sort().at(-1);
	const start = last ? Number(last.slice(0, 2)) + 2 : 16;
	for (let step = 0; step < 24; step++) {
		const candidate = `${String((start + step) % 24).padStart(2, '0')}:00`;
		if (!times.includes(candidate)) return candidate;
	}
	return '12:00';
}

/** Whether the evening count reaches the viewer: on, off, or no channel yet to switch it on. */
export type ReminderMine = 'on' | 'off' | 'no-channel';

/** What the notification preferences route says, as far as the evening count needs it. */
export interface PreferencesView {
	kinds: readonly { id: string; defaultChannels: readonly string[] }[];
	channels: readonly { id: string; available: boolean }[];
	prefs: { kinds: Record<string, Record<string, boolean>> };
}

/**
 * Whether the viewer gets the evening count, from their notification preferences: on when a
 * channel that reaches them is switched on for it, off when none is, and `no-channel` when it is
 * not offered to them (it needs a phone or Telegram first). Null without preferences (the viewer
 * may not receive notifications).
 */
export function mineState(
	preferences: PreferencesView | null,
	kindId = 'chores.leftToday',
): ReminderMine | null {
	if (!preferences) return null;
	const kind = preferences.kinds.find((k) => k.id === kindId);
	if (!kind) return 'no-channel';
	const chosen = preferences.prefs.kinds[kindId] ?? {};
	const on = preferences.channels.some(
		(c) => c.available && (chosen[c.id] ?? kind.defaultChannels.includes(c.id)),
	);
	return on ? 'on' : 'off';
}

/** The times as the family reads them (their clock: 18:00 or 6:00 PM), joined with commas. */
export function formatTimes(
	times: readonly string[],
	dateLocale: string,
	hourCycle: 'h12' | 'h23',
): string {
	return times.map((time) => formatClock(time, dateLocale, hourCycle)).join(', ');
}
