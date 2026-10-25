import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';
import { addDays, DAY_MS, daysBetween } from './dates.ts';
import { type Recurrence, WEEKDAYS, type Weekday } from './recurrence.ts';

// Display helpers (Intl; the caller supplies translations).

/** A local date (`YYYY-MM-DD`) formatted for display; no time zone can shift it. */
export function formatDate(
	date: string,
	locale: string,
	options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' },
): string {
	return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(
		Date.parse(`${date}T12:00:00Z`),
	);
}

/** The words of a relative day, in the reader's language. */
export interface RelativeDayWords {
	/** More than a day ago: "3 days overdue". */
	overdue(days: number): string;
	yesterday: string;
	today: string;
	tomorrow: string;
}

/**
 * A date against `today` the way a due day reads: yesterday, today and tomorrow in words, earlier
 * ones as `overdue(days)`, the coming week by weekday and later days as a short date.
 */
export function relativeDayLabel(
	date: string,
	today: string,
	locale: string,
	words: RelativeDayWords,
): string {
	const days = daysBetween(today, date);
	if (days < -1) return words.overdue(-days);
	if (days === -1) return words.yesterday;
	if (days === 0) return words.today;
	if (days === 1) return words.tomorrow;
	return formatDate(
		date,
		locale,
		days < 7 ? { weekday: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' },
	);
}

/** First day of the week as an ISO weekday number: 1 = Monday … 7 = Sunday. */
export const WeekStartSchema = z.number().int().min(1).max(7);

/** The seven days of the week starting at `weekStart`, as RRULE codes (`orderedWeekdays(7)` = SU, MO …). */
export function orderedWeekdays(weekStart = 1): Weekday[] {
	const start = (((weekStart - 1) % 7) + 7) % 7;
	return Array.from({ length: 7 }, (_, i) => WEEKDAYS[(start + i) % 7] as Weekday);
}

/** The seven dates of the week containing `date`, starting on `weekStart` (1 = Monday … 7 = Sunday). */
export function weekOf(date: string, weekStart = 1): string[] {
	const d = Temporal.PlainDate.from(date);
	const back = (d.dayOfWeek - weekStart + 7) % 7;
	const first = d.subtract({ days: back }).toString();
	return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * The dates around `today`, one line each with its English weekday ("Tue 2026-10-13 (today)"),
 * from `before` days back to `after` days ahead. Models work weekdays out wrongly; a prompt that
 * carries this table lets them look a weekday up instead. English because prompts are English.
 */
export function daysAround(today: string, before = 7, after = 14): string[] {
	const label = (offset: number) =>
		offset === -1 ? ' (yesterday)' : offset === 0 ? ' (today)' : offset === 1 ? ' (tomorrow)' : '';
	return Array.from({ length: before + after + 1 }, (_, i) => {
		const date = addDays(today, i - before);
		return `${formatDate(date, 'en', { weekday: 'short' })} ${date}${label(i - before)}`;
	});
}

/** Localized short weekday names in RRULE order (MO … SU). */
export function weekdayNames(
	locale: string,
	style: 'short' | 'long' = 'short',
): Record<Weekday, string> {
	const monday = Date.parse('2026-01-05T12:00:00Z'); // a Monday
	const fmt = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' });
	return Object.fromEntries(WEEKDAYS.map((w, i) => [w, fmt.format(monday + i * DAY_MS)])) as Record<
		Weekday,
		string
	>;
}

type RecurrenceT = (
	key: 'repeat_daily' | 'repeat_weekly' | 'repeat_weekly_on' | 'repeat_monthly' | 'repeat_until',
	options?: Record<string, unknown>,
) => string;

/**
 * How a repeat reads. With `startDate`, a plain weekly repeat on that date's own weekday reads
 * "Every Saturday" instead of naming the day twice.
 */
export function describeRecurrence(
	rec: Recurrence,
	t: RecurrenceT,
	locale: string,
	weekStart = 1,
	startDate?: string,
): string {
	const ownDay =
		rec.freq === 'weekly' &&
		rec.interval === 1 &&
		rec.byDay.length === 1 &&
		startDate !== undefined &&
		rec.byDay[0] === WEEKDAYS[Temporal.PlainDate.from(startDate).dayOfWeek - 1]
			? rec.byDay[0]
			: undefined;
	let text =
		rec.freq === 'daily'
			? t('repeat_daily')
			: rec.freq === 'monthly'
				? t('repeat_monthly')
				: ownDay
					? t('repeat_weekly_on', { day: weekdayNames(locale, 'long')[ownDay] })
					: t('repeat_weekly');
	if (rec.freq === 'weekly' && !ownDay) {
		const names = weekdayNames(locale);
		const order = orderedWeekdays(weekStart);
		const days = [...rec.byDay].sort((a, b) => order.indexOf(a) - order.indexOf(b));
		text += ` · ${days.map((d) => names[d]).join(', ')}`;
	}
	if (rec.interval > 1) text = `${text} (×${rec.interval})`;
	if (rec.until)
		text += ` · ${t('repeat_until', { date: formatDate(rec.until, locale, { day: 'numeric', month: 'short', year: 'numeric' }) })}`;
	return text;
}
