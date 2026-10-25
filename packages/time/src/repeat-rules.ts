import { Temporal } from 'temporal-polyfill';
import { addDays, compareDates } from './dates.ts';
import { expandDates, type Recurrence, toRRule, WEEKDAYS } from './recurrence.ts';

/** A repeat every N months or every N years (the interval of a bill, an obligation). */
export type MonthlyOrYearly = { months?: number | undefined; years?: number | undefined };

/**
 * Repeats of a bill or an obligation: every N months or years from a first due date (the anchor).
 * Stored as an RFC 5545 rule (`FREQ=MONTHLY;INTERVAL=3`) so other tools can read it, but expanded
 * by `nextEveryDue`: RFC 5545 skips months that lack the anchor's day (a 31st), while a family's
 * duty on "the 31st" falls on the last day of a short month.
 */
export function everyToRule(every: MonthlyOrYearly): string {
	return every.months !== undefined
		? `FREQ=MONTHLY;INTERVAL=${every.months}`
		: `FREQ=YEARLY;INTERVAL=${every.years}`;
}

export function everyFromRule(rule: string | null): { months: number } | { years: number } | null {
	if (!rule) return null;
	const m = /^FREQ=(MONTHLY|YEARLY);INTERVAL=(\d+)$/.exec(rule);
	if (!m) return null;
	const n = Number(m[2]);
	return m[1] === 'MONTHLY' ? { months: n } : { years: n };
}

/**
 * The first occurrence strictly after `after`, counting from `anchor` (never from the previous
 * occurrence, so Jan 31 → Feb 28 → Mar 31, and Feb 29 → Feb 28 → … → Feb 29).
 */
export function nextEveryDue(anchor: string, every: MonthlyOrYearly, after: string): string {
	const start = Temporal.PlainDate.from(anchor);
	for (let k = 1; ; k++) {
		const candidate = (
			every.months !== undefined
				? start.add({ months: k * every.months })
				: start.add({ years: k * (every.years as number) })
		).toString();
		if (compareDates(candidate, after) > 0) return candidate;
	}
}

/**
 * How something repeats, in parts that hold no language: a model reads "every other Wednesday"
 * or "her çarşamba" into these, and code turns them into a repeat rule.
 */
export interface RepeatParts {
	every: 'day' | 'week' | 'month' | 'year';
	/** Every how many days, weeks, months or years; 1 when absent. */
	interval?: number | undefined;
	/** For weekly repeats: 1 = Monday … 7 = Sunday. */
	weekdays?: readonly number[] | undefined;
	/** How many times in all, when the words say. */
	count?: number | undefined;
}

/** The longest interval each preset holds (a yearly repeat is a monthly one of 12). */
const MAX_INTERVAL = { daily: 365, weekly: 52, monthly: 12 } as const;

/** The last day of the month a date is in. */
export function lastDayOfMonth(date: string): string {
	const day = Temporal.PlainDate.from(date);
	return day.with({ day: day.daysInMonth }).toString();
}

/** 1 = Monday … 7 = Sunday, of a `YYYY-MM-DD` date. */
const isoDayOf = (date: string) => Temporal.PlainDate.from(date).dayOfWeek;

/**
 * The first date on or after `from` that a weekly repeat on these weekdays holds: a series
 * starts on one of its own days, never on a day it does not repeat on.
 */
export function firstWeekday(from: string, weekdays: readonly number[]): string {
	for (let i = 0; i < 7; i++) {
		const date = addDays(from, i);
		if (weekdays.includes(isoDayOf(date))) return date;
	}
	return from;
}

export interface RepeatRule {
	/** The rule as the presets hold it. */
	recurrence: Recurrence;
	/** The first date: `start`, moved forward to the first day a weekly repeat holds. */
	start: string;
	/** False when the parts asked for more than the presets hold (an interval cut to the limit). */
	exact: boolean;
}

/**
 * The repeat rule some repeat parts and a first date name. A weekly repeat without weekdays
 * repeats on the first date's weekday; a yearly one is every 12 months. `until` (inclusive) ends
 * it; else a `count` ends it on its last date. An end before the first date is left out and the
 * rule is not exact.
 */
export function repeatRule(
	parts: RepeatParts,
	start: string,
	until?: string | null | undefined,
): RepeatRule {
	let exact = true;
	const bounded = (max: number, value: number) => {
		if (value > max) exact = false;
		return Math.min(Math.max(1, Math.trunc(value)), max);
	};
	const given = parts.interval ?? 1;
	let recurrence: Recurrence;
	let first = start;
	if (parts.every === 'day') {
		recurrence = { freq: 'daily', interval: bounded(MAX_INTERVAL.daily, given) };
	} else if (parts.every === 'week') {
		const days = [...new Set(parts.weekdays ?? [])].filter((d) => d >= 1 && d <= 7);
		const weekdays = days.length > 0 ? days.toSorted((a, b) => a - b) : [isoDayOf(start)];
		first = firstWeekday(start, weekdays);
		recurrence = {
			freq: 'weekly',
			interval: bounded(MAX_INTERVAL.weekly, given),
			byDay: weekdays.map((d) => WEEKDAYS[d - 1] as (typeof WEEKDAYS)[number]),
		};
	} else {
		const months = parts.every === 'year' ? given * 12 : given;
		recurrence = { freq: 'monthly', interval: bounded(MAX_INTERVAL.monthly, months) };
	}
	let end = until ?? null;
	if (end === null && parts.count !== undefined && parts.count >= 1) {
		// The count-th date of the rule, looked for as far as the count can reach.
		const reach = { daily: 1, weekly: 7, monthly: 31 }[recurrence.freq] * recurrence.interval;
		const dates = expandDates(
			{ date: first, rrule: toRRule(recurrence, null) },
			first,
			addDays(first, reach * parts.count + 7),
		);
		end = dates[Math.trunc(parts.count) - 1] ?? null;
		if (end === null) exact = false;
	}
	if (end !== null && end < first) {
		end = null;
		exact = false;
	}
	if (end !== null) recurrence = { ...recurrence, until: end };
	return { recurrence, start: first, exact };
}
