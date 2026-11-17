import type { Page } from '@playwright/test';
import { FAMILY_TIME_ZONE } from './sign-in.ts';

/** The family's day, and a clock to stand at a time of day. */

const STARTED = Date.now();

/**
 * The time the run reads as now, in epoch milliseconds. Normally the real time; when
 * `FAMOS_E2E_FIXED_NOW` (an ISO instant) is set, that instant, moving on from the start of the
 * run. The README pictures set it so they show one day whatever day they are made on.
 */
export const now = (): number => {
	const fixed = process.env.FAMOS_E2E_FIXED_NOW;
	return fixed ? Date.parse(fixed) + (Date.now() - STARTED) : Date.now();
};

/** The family's date `offset` days from today, as YYYY-MM-DD. */
export const day = (offset: number): string =>
	new Intl.DateTimeFormat('en-CA', { timeZone: FAMILY_TIME_ZONE }).format(
		new Date(now() + offset * 86_400_000),
	);

/** The browser's clock: today at `time` (HH:MM) in the family's zone (Istanbul has no DST now). */
export async function standAt(page: Page, time: string) {
	await page.clock.setFixedTime(new Date(`${day(0)}T${time}:00+03:00`));
}
