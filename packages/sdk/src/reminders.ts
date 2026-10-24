import type { FamilySettings } from './context.ts';
import type { EnqueueOptions } from './ports.ts';
import { MINUTE_MS } from './time-units.ts';

/** A reminder may be this late at scheduling time (clock drift) and still go out. */
export const REMINDER_LATE_MS = 5 * MINUTE_MS;

/** The local time a reminder for something with a day but no time of day is sent. */
export const DEFAULT_REMINDER_TIME = '09:00';

/** The family settings a reminder is planned from. */
export type ReminderSettings = Pick<FamilySettings, 'timeZone' | 'reminderTime'>;

/** What a reminder planner needs of `uow.enqueue` or `ctx.enqueue`. */
export type EnqueueJob = (
	job: string,
	payload: unknown,
	options?: EnqueueOptions,
) => Promise<unknown>;

/** Whether a reminder due at `at` is too far in the past to still be sent at `now`. */
export const reminderMissed = (at: number, now: number): boolean => at < now - REMINDER_LATE_MS;

/**
 * Whether a reminder job no longer matches its record: planned for another version of the record
 * (`updated_at`) or another due day, or the record has no due day any more.
 */
export function reminderStale(
	planned: { version: number | string; date: string },
	current: { version: number | string; date: string | null },
): boolean {
	return current.version !== planned.version || current.date !== planned.date;
}
