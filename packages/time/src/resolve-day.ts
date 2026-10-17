import { Temporal } from 'temporal-polyfill';
import {
	type DateOrder,
	type DateWords,
	namedDistance,
	namedWeekdays,
	writtenDates,
} from './date-words.ts';

/**
 * Which day some words name, in parts that hold no language: a model reads "next Thursday" or
 * "15 Ekim" into these, and code works out the date. Every part is optional.
 */
export interface DayParts {
	/** The words that name the day, as written; checked against the parts when words are given. */
	text?: string | undefined;
	day?: number | undefined;
	month?: number | undefined;
	year?: number | undefined;
	/** 1 = Monday … 7 = Sunday. */
	weekday?: number | undefined;
	/** Which week, only when the words say so. */
	week?: 'this' | 'next' | 'after_next' | undefined;
	/** Days from today when the words count them ("tomorrow" = 1, "yesterday" = -1). */
	inDays?: number | undefined;
	/** An all-numeric date as written ("03/04", "3.11.", "2026-10-20"); read in the family order. */
	numeric?: string | undefined;
	/** A vague span ("end of the month", "early November"). */
	approximate?: boolean | undefined;
}

/**
 * Where a day without a year (or without a month) falls: the coming one for plans, the last one
 * for things done, the closest one when either fits.
 */
export type DayDirection = 'future' | 'past' | 'nearest';

/**
 * Why a date is a guess:
 * - `mismatch`: the parts disagree with each other or with the quoted words; the day number wins.
 * - `approximate`: the words name a span, not a day.
 * - `guessed_year`: no year was written and the date falls far enough away that the other year
 *   could be meant.
 * - `weekday_only`: only a weekday was named ("on Thursday"), so the week is a reading.
 * - `relative`: counted days ("in two weeks") are often meant loosely.
 */
export type DayDoubt = 'mismatch' | 'approximate' | 'guessed_year' | 'weekday_only' | 'relative';

export interface DayResult {
	/** `YYYY-MM-DD`. */
	date: string;
	/** True when the words name exactly this day; otherwise `why` says what was guessed. */
	certain: boolean;
	why?: DayDoubt;
}

export interface ResolveDayOptions {
	/** Today in the family time zone, `YYYY-MM-DD`. */
	today: string;
	/** The family's first day of the week (1 = Monday … 7 = Sunday), for `week`. Default 1. */
	weekStart?: number | undefined;
	/** Order of the family's all-numeric dates. Default `DMY`. */
	order?: DateOrder | undefined;
	/** Default `future`. */
	direction?: DayDirection | undefined;
	/** When the thing happens (`HH:MM`): today's own weekday is today only while it is ahead. */
	time?: string | undefined;
	/** The time now (`HH:MM`), compared with `time`. */
	now?: string | undefined;
	/** Date words of the installed languages, to check the parts against the quoted `text`. */
	words?: DateWords | undefined;
}

/** A date without a year that is further away than this may well mean the other year. */
const UNCLEAR_YEAR_DAYS = 183;

const DOUBT_RANK: readonly DayDoubt[] = [
	'relative',
	'weekday_only',
	'guessed_year',
	'approximate',
	'mismatch',
];

type PlainDate = Temporal.PlainDate;
type Source = 'number' | 'count' | 'month' | 'weekday';

const cmp = (a: PlainDate, b: PlainDate) => Temporal.PlainDate.compare(a, b);
const daysBetween = (a: PlainDate, b: PlainDate) => Math.abs(a.until(b).days);

function make(year: number, month: number, day: number): PlainDate | null {
	try {
		return Temporal.PlainDate.from({ year, month, day }, { overflow: 'reject' });
	} catch {
		return null;
	}
}

/** Of a later and an earlier candidate, the one the direction wants. */
function pick(
	later: PlainDate | null,
	earlier: PlainDate | null,
	today: PlainDate,
	direction: DayDirection,
): PlainDate | null {
	if (direction === 'future') return later ?? earlier;
	if (direction === 'past') return earlier ?? later;
	if (!later || !earlier) return later ?? earlier;
	return daysBetween(today, earlier) < daysBetween(today, later) ? earlier : later;
}

/** A day and month without a year: the one the direction wants, and whether its year is a guess. */
function withYear(
	month: number,
	day: number,
	today: PlainDate,
	direction: DayDirection,
): { date: PlainDate; guessed: boolean } | null {
	// Several years either way, so 29 February finds its leap year.
	const candidates = Array.from({ length: 9 }, (_, i) => make(today.year - 4 + i, month, day))
		.filter((d): d is PlainDate => d !== null)
		.toSorted(cmp);
	const later = candidates.find((d) => cmp(d, today) >= 0) ?? null;
	const earlier = candidates.findLast((d) => cmp(d, today) <= 0) ?? null;
	const date = pick(later, earlier, today, direction);
	return date ? { date, guessed: daysBetween(today, date) > UNCLEAR_YEAR_DAYS } : null;
}

/** A day number alone ("on the 20th"): in this month, or the next or last that has it. */
function dayOfMonth(day: number, today: PlainDate, direction: DayDirection): PlainDate | null {
	const first = today.with({ day: 1 });
	const inMonth = (offset: number) => {
		const month = first.add({ months: offset });
		return make(month.year, month.month, day);
	};
	const months = Array.from({ length: 13 }, (_, i) => i);
	const later =
		months.map(inMonth).find((d): d is PlainDate => d !== null && cmp(d, today) >= 0) ?? null;
	const earlier =
		months.map((i) => inMonth(-i)).find((d): d is PlainDate => d !== null && cmp(d, today) <= 0) ??
		null;
	return pick(later, earlier, today, direction);
}

/**
 * An all-numeric date in the family order. A four-digit first number is a year (ISO). When the
 * family order gives no valid date ("10/20" read day first), the other reading is taken and
 * marked, because the writer clearly used another order.
 */
function numericParts(
	numeric: string,
	order: DateOrder,
): { day: number; month: number; year?: number; swapped: boolean } | null {
	const parts = numeric.split(/\D+/u).filter(Boolean);
	if (parts.length < 2 || parts.length > 3) return null;
	const n = parts.map(Number);
	const valid = (day: number, month: number) => day >= 1 && day <= 31 && month >= 1 && month <= 12;
	if (parts.length === 3) {
		const isoLike = (parts[0] as string).length === 4 || order === 'YMD';
		const [a, b, c] = n as [number, number, number];
		const [year, month, day] = isoLike ? [a, b, c] : order === 'MDY' ? [c, a, b] : [c, b, a];
		const fullYear = year < 100 ? 2000 + year : year;
		if (valid(day, month)) return { day, month, year: fullYear, swapped: false };
		if (!isoLike && valid(month, day))
			return { day: month, month: day, year: fullYear, swapped: true };
		return null;
	}
	const [a, b] = n as [number, number];
	// With the year first, a bare "10/08" is month-day (the usual short form there).
	const [day, month] = order === 'DMY' ? [a, b] : [b, a];
	if (valid(day, month)) return { day, month, swapped: false };
	if (valid(month, day)) return { day: month, month: day, swapped: true };
	return null;
}

/**
 * A weekday: with `week`, the one in that week (weeks start on `weekStart`); else the coming one.
 * Today's own weekday is today while `time` is still ahead of `now` (or either is unknown), else
 * a week later; for things done it is today once `time` has passed, else a week earlier.
 */
function weekdayDate(
	weekday: number,
	week: DayParts['week'],
	today: PlainDate,
	options: ResolveDayOptions,
	direction: DayDirection,
): PlainDate {
	if (week) {
		const weekStart = options.weekStart ?? 1;
		const start = today.subtract({ days: (today.dayOfWeek - weekStart + 7) % 7 });
		const shift = { this: 0, next: 7, after_next: 14 }[week];
		const date = start.add({ days: ((weekday - weekStart + 7) % 7) + shift });
		// "This Thursday" said on a Friday about a plan means the coming one, and the other way
		// round for something done.
		const wrongSide =
			week === 'this' &&
			((direction === 'future' && cmp(date, today) < 0) ||
				(direction === 'past' && cmp(date, today) > 0));
		if (!wrongSide) return date;
	}
	const { time, now } = options;
	const known = time !== undefined && now !== undefined;
	const ahead = !known || time > now;
	const passed = !known || time <= now;
	const forward = (weekday - today.dayOfWeek + 7) % 7;
	const coming = today.add({ days: forward === 0 && !ahead ? 7 : forward });
	const backward = (today.dayOfWeek - weekday + 7) % 7;
	const last = today.subtract({ days: backward === 0 && !passed ? 7 : backward });
	return pick(coming, last, today, direction) as PlainDate;
}

/** A month without a day ("early November"): its first day, or today when that is this month. */
function monthOnly(
	month: number,
	year: number | undefined,
	today: PlainDate,
	direction: DayDirection,
): PlainDate | null {
	if (year !== undefined) return make(year, month, 1);
	if (month === today.month) return direction === 'future' ? today : today.with({ day: 1 });
	const later = make(month > today.month ? today.year : today.year + 1, month, 1);
	const earlier = make(month < today.month ? today.year : today.year - 1, month, 1);
	return pick(later, earlier, today, direction);
}

/**
 * The date a day reference names, and whether it is certain. The parts are read in this order:
 * an all-numeric date (in the family order), a day and month (and year), a day number, counted
 * days, a month, a weekday. A later part that disagrees with the date found is a `mismatch`; the
 * day number wins over a weekday or a count. With `words`, the quoted text is read too: a date it
 * writes wins over the parts (code reads the family order and the month names itself), and a
 * weekday it names that the date does not fall on is a `mismatch`. Null when nothing names a day.
 */
export function resolveDay(
	ref: DayParts | undefined,
	options: ResolveDayOptions,
): DayResult | null {
	if (!ref) return null;
	const today = Temporal.PlainDate.from(options.today);
	const order = options.order ?? 'DMY';
	const direction = options.direction ?? 'future';
	let why: DayDoubt | undefined;
	const doubt = (reason: DayDoubt) => {
		if (why === undefined || DOUBT_RANK.indexOf(reason) > DOUBT_RANK.indexOf(why)) why = reason;
	};
	// Typed by assertion: the closures below assign them, which narrowing cannot see.
	let date = null as PlainDate | null;
	/** How the date was found: a day number, a count, a month, or a weekday only. */
	let source = null as Source | null;
	const settle = (found: PlainDate | null, from: Source) => {
		if (found === null) return;
		if (date === null) {
			date = found;
			source = from;
		} else if (!found.equals(date)) doubt('mismatch');
	};
	const dayAndMonth = (day: number, month: number, year: number | undefined) => {
		if (year !== undefined) return make(year, month, day);
		const found = withYear(month, day, today, direction);
		if (found?.guessed && date === null) doubt('guessed_year');
		return found?.date ?? null;
	};

	if (ref.numeric?.trim()) {
		const parts = numericParts(ref.numeric, order);
		if (parts) {
			settle(dayAndMonth(parts.day, parts.month, parts.year), 'number');
			if (parts.swapped) doubt('mismatch');
		}
	}
	if (ref.day !== undefined && ref.month !== undefined)
		settle(dayAndMonth(ref.day, ref.month, ref.year), 'number');
	else if (ref.day !== undefined) settle(dayOfMonth(ref.day, today, direction), 'number');
	if (ref.inDays !== undefined) {
		const counted = today.add({ days: ref.inDays });
		if (date === null && Math.abs(ref.inDays) > 1) doubt('relative');
		settle(counted, 'count');
	}
	if (date === null && ref.month !== undefined) {
		settle(monthOnly(ref.month, ref.year, today, direction), 'month');
		doubt('approximate');
	}
	if (ref.weekday !== undefined) {
		if (date === null) {
			settle(weekdayDate(ref.weekday, ref.week, today, options, direction), 'weekday');
			doubt('weekday_only');
		} else if (date.dayOfWeek !== ref.weekday) doubt('mismatch');
	}

	const text = ref.text?.trim();
	if (options.words && text) {
		const written = writtenDates(text, options.words, order)
			.map((d) =>
				d.year !== undefined
					? { date: make(d.year, d.month, d.day), guessed: false }
					: withYear(d.month, d.day, today, direction),
			)
			.filter((d): d is { date: PlainDate; guessed: boolean } => d?.date != null);
		const [only] = written;
		if (written.length === 1 && only) {
			if (date === null) {
				date = only.date;
				source = 'number';
				if (only.guessed) doubt('guessed_year');
			} else if (!only.date.equals(date)) {
				date = only.date;
				source = 'number';
				doubt('mismatch');
			}
		}
		// Only the words, without the parts: a day they name by its distance ("tomorrow") is
		// that day, as certain as if the model had counted it.
		const distance = date === null ? namedDistance(text, options.words) : null;
		if (distance !== null) {
			date = today.add({ days: distance });
			source = 'count';
		}
		const named = namedWeekdays(text, options.words);
		// Only the words, without the parts: a weekday they name is read as a weekday alone.
		if (date === null && named.length === 1) {
			date = weekdayDate(named[0] as number, ref.week, today, options, direction);
			source = 'weekday';
			doubt('weekday_only');
		}
		// Only the words, and they hold one number standing alone ("on the 15th", "ayın 15'i"):
		// most often the day of the month, read as one for a person to check.
		const numbers = text.match(/(?<![\p{N}.:/-])\p{N}{1,2}(?![\p{N}.:/-])/gu) ?? [];
		const [alone] = numbers;
		if (date === null && numbers.length === 1 && alone) {
			const found = dayOfMonth(Number(alone), today, direction);
			if (found) {
				date = found;
				source = 'number';
				doubt('approximate');
			}
		}
		if (date && named.length > 0 && !named.includes(date.dayOfWeek)) {
			// A weekday the model misread: the one the words name is taken, still as a weekday.
			if (source === 'weekday' && named.length === 1)
				date = weekdayDate(named[0] as number, ref.week, today, options, direction);
			doubt('mismatch');
		}
	}

	if (date === null) return null;
	if (ref.approximate) doubt('approximate');
	const iso = date.toString();
	return why === undefined ? { date: iso, certain: true } : { date: iso, certain: false, why };
}
