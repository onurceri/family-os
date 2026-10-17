import type { AnyActionDefinition, ExtensionContext } from '@famos/sdk';
import { addDays, compareDates, dayBounds, isValidDate, todayIn } from '@famos/time';
import { readStoredInput } from './stored-input.ts';

/**
 * Suggestions about a day that has passed go away by themselves: a dinner planned for last
 * Saturday means nothing on Sunday. An action says which day a draft is about (`draftDate`).
 */

/** Statuses of a draft that still waits for a person (and so can expire). */
export const WAITING_STATUSES = ['pending', 'failed'] as const;

/** Whether the day a draft is about (`YYYY-MM-DD`) is before today (both in family time). */
export function hasPassed(draftDate: string | undefined, today: string): boolean {
	if (draftDate === undefined || !isValidDate(draftDate)) return false;
	return compareDates(draftDate, today) < 0;
}

/** The day a draft is about, from its action and its (edited) input; undefined when none. */
export function draftDateOf(
	def: AnyActionDefinition | undefined,
	draft: { input: string; edited_input: string | null },
): string | undefined {
	if (!def?.draftDate) return undefined;
	try {
		return def.draftDate(readStoredInput(def, draft.edited_input ?? draft.input)) ?? undefined;
	} catch {
		// An input stored by an older version may not fit today's shape: it never expires.
		return undefined;
	}
}

export const EXPIRE_JOB = 'core.expireDrafts';

/** How long after midnight (family time) the daily expiry runs. */
const AFTER_MIDNIGHT_MS = 5 * 60 * 1000;

/** When the next expiry runs: a few minutes after the coming midnight in the family's time zone. */
export function nextExpiryAt(now: number, timeZone: string): { at: number; day: string } {
	const day = addDays(todayIn(timeZone, now), 1);
	return { at: dayBounds(day, timeZone).start + AFTER_MIDNIGHT_MS, day };
}

/** One pending run per day (the key names the day), so restarts and the job's own rescheduling never pile up. */
export async function scheduleExpiry(
	ctx: Pick<ExtensionContext, 'enqueue' | 'clock' | 'family'>,
): Promise<void> {
	const { timeZone } = await ctx.family.settings();
	const { at, day } = nextExpiryAt(ctx.clock.now(), timeZone);
	await ctx.enqueue(EXPIRE_JOB, {}, { runAt: at, dedupeKey: `${EXPIRE_JOB}:${day}` });
}
