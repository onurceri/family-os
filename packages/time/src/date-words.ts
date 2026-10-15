import { Temporal } from 'temporal-polyfill';

/**
 * Dates in people's own words: which weekday or day number a text names, and whether that fits a
 * date. Models miscount weekdays, so these checks are made in code. Code holds no words of any
 * language: the words come from the language catalogs (`vocabulary`, every installed language).
 */

/** Order of day, month and year in the family's all-numeric dates. */
export type DateOrder = 'DMY' | 'MDY' | 'YMD';

/** The date words a check reads. Each list is lower-case. */
export interface DateWords {
	/** Words that name exactly one day ("today", "tomorrow", "this evening"). */
	exactDay: readonly string[];
	/** Names of the weekdays, Monday first (index 0 = Monday). */
	weekdays: readonly (readonly string[])[];
	/** Short names of the weekdays ("wed"), Monday first; only whole words match. */
	weekdaysShort: readonly (readonly string[])[];
	/** Names of the months, January first, full and short. */
	months: readonly (readonly string[])[];
	/** Words before a clock time ("at 9"). */
	beforeTime: readonly string[];
	/** Endings right after an hour that make it a time ("9 o'clock"). */
	afterHour: readonly string[];
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** The date words of every installed language, from `ExtensionContext.vocabulary`. */
export function dateWords(vocabulary: (key: string) => readonly string[]): DateWords {
	return {
		exactDay: vocabulary('app:words_exact_day'),
		weekdays: range(7).map((n) => vocabulary(`app:words_weekday_${n}`)),
		weekdaysShort: range(7).map((n) => vocabulary(`app:words_weekday_short_${n}`)),
		months: range(12).map((n) => vocabulary(`app:words_month_${n}`)),
		beforeTime: vocabulary('app:words_before_time'),
		afterHour: vocabulary('app:words_after_hour'),
	};
}

const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = (words: readonly string[]) =>
	words
		.toSorted((a, b) => b.length - a.length)
		.map(escapeRegex)
		.join('|');

/** Clock times ("16:30", "4:30pm", "at 9", "9 o'clock") so their digits are not read as days. */
function timePatterns(words: DateWords): RegExp[] {
	const patterns = [
		/\d{1,2}[:.]\d{2}\s*(am|pm|a\.m\.|p\.m\.)?/giu,
		/\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)/giu,
	];
	if (words.beforeTime.length)
		patterns.push(new RegExp(`(?<!\\p{L})(${anyOf(words.beforeTime)})\\s*\\d{1,2}`, 'giu'));
	if (words.afterHour.length)
		patterns.push(new RegExp(`\\d{1,2}\\s?(${anyOf(words.afterHour)})(?!\\p{L})`, 'giu'));
	return patterns;
}

/** The text with its clock times blanked out (same length, so positions stay where they were). */
function withoutTimes(text: string, words: DateWords): string {
	return timePatterns(words).reduce(
		(t, re) => t.replace(re, (match) => ' '.repeat(match.length)),
		text,
	);
}

/** A name found in a text, with where it stands. */
interface Found {
	start: number;
	end: number;
	/** The weekday (1 = Monday) or the month (1 = January) it names. */
	value: number;
}

/**
 * Where the names of a list (weekdays, months) stand in a text. A longer name wins over one it
 * contains; `whole` keeps short names from matching inside words ("wed" in "wedding").
 */
function namesIn(
	text: string,
	lists: readonly (readonly string[])[],
	whole: (name: string) => boolean,
): Found[] {
	const names = lists
		.flatMap((list, i) => list.map((name) => ({ name, value: i + 1 })))
		.toSorted((a, b) => b.name.length - a.name.length);
	if (names.length === 0) return [];
	const pattern = names
		.map((n) => `${escapeRegex(n.name)}${whole(n.name) ? '(?!\\p{L})' : ''}`)
		.join('|');
	const re = new RegExp(`(?<!\\p{L})(${pattern})`, 'giu');
	const found: Found[] = [];
	for (const m of text.matchAll(re)) {
		const said = (m[1] ?? '').toLocaleLowerCase();
		const hit = names.find((n) => n.name === said);
		if (hit) found.push({ start: m.index, end: m.index + said.length, value: hit.value });
	}
	return found;
}

/** Weekday numbers (1 = Monday) named in the text by their full names. */
function weekdaysIn(text: string, words: DateWords): number[] {
	return [...new Set(namesIn(text, words.weekdays, () => false).map((f) => f.value))];
}

/**
 * Whether a chosen date is a guess, judged from the words the model quotes as its source:
 * - no quote, or no day number in it ("next Thursday", "end of the month");
 *   words like "tomorrow" and "today" name the day themselves;
 * - a day number or weekday in the quote that does not match the chosen date (a notice naming
 *   a Thursday for a date that is a Friday).
 */
export function isUncertainDate(
	text: string | undefined,
	date: string,
	vocabulary: DateWords,
	order: DateOrder = 'DMY',
): boolean {
	if (!text?.trim()) return true;
	const words = withoutTimes(text, vocabulary);
	if (
		vocabulary.exactDay.length &&
		new RegExp(`(?<!\\p{L})(${anyOf(vocabulary.exactDay)})`, 'iu').test(words)
	)
		return false;
	if (readsOtherWay(words, date, order)) return true;
	const days = [...words.matchAll(/(?<!\d)(\d{1,2})(?!\d)/g)]
		.map((m) => Number(m[1]))
		.filter((d) => d >= 1 && d <= 31);
	if (days.length === 0) return true;
	const chosen = Temporal.PlainDate.from(date);
	if (!days.includes(chosen.day)) return true;
	const named = weekdaysIn(words, vocabulary);
	return named.length > 0 && !named.includes(chosen.dayOfWeek);
}

/**
 * An all-numeric date such as "03/04" whose two numbers are both 12 or less can be read two ways.
 * The family's own order settles it; a chosen date that follows the other reading is a guess.
 */
function readsOtherWay(words: string, date: string, order: DateOrder): boolean {
	const m = /(?<![\d./-])(\d{1,2})\s*[/.-]\s*(\d{1,2})(?![\d])/.exec(words);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a > 12 || b > 12 || a === 0 || b === 0 || a === b) return false;
	const chosen = Temporal.PlainDate.from(date);
	// With the year first, a bare "10/08" is month-day (the usual short form there).
	const [day, month] = order === 'DMY' ? [a, b] : [b, a];
	return chosen.day !== day || chosen.month !== month;
}

/** A weekday a person named next to a date that falls on another weekday. */
export interface WeekdayMismatch {
	/** The words, as written ("Wednesday 20 October"). */
	said: string;
	/** The date they name, `YYYY-MM-DD`. */
	date: string;
	/** The weekday the person said (1 = Monday … 7 = Sunday). */
	saidWeekday: number;
	/** The weekday the date really is. */
	weekday: number;
}

interface DateFound {
	start: number;
	end: number;
	day: number;
	month: number;
	year?: number;
}

/** A day number with an ordinal ending of up to two letters ("20th"), and a dot ("20."). */
const DAY = '(\\d{1,2})(?:\\p{L}{1,2})?\\.?';
const YEAR = '(?:[\\s,]+(\\d{4}))?';

/** The dates a text writes out: "20 October", "October 20, 2026", "2026-10-20", "20/10". */
function datesIn(text: string, words: DateWords, order: DateOrder): DateFound[] {
	const found: DateFound[] = [];
	const at = (m: RegExpMatchArray, fields: Omit<DateFound, 'start' | 'end'>) => {
		const start = m.index as number;
		found.push({ start, end: start + m[0].length, ...fields });
	};
	const months = words.months
		.flatMap((list, i) => list.map((name) => ({ name, month: i + 1 })))
		.toSorted((a, b) => b.name.length - a.name.length);
	if (months.length > 0) {
		const name = `(${months.map((m) => escapeRegex(m.name)).join('|')})`;
		const monthOf = (said: string | undefined) =>
			months.find((m) => m.name === said?.toLocaleLowerCase())?.month ?? 0;
		for (const m of text.matchAll(
			new RegExp(`(?<![\\d\\p{L}])${DAY}[\\s,]*${name}(?!\\p{L})\\.?${YEAR}`, 'giu'),
		))
			at(m, { day: Number(m[1]), month: monthOf(m[2]), year: m[3] ? Number(m[3]) : undefined });
		for (const m of text.matchAll(
			new RegExp(`(?<!\\p{L})${name}\\.?[\\s,]*${DAY}(?![\\d])${YEAR}`, 'giu'),
		))
			at(m, { day: Number(m[2]), month: monthOf(m[1]), year: m[3] ? Number(m[3]) : undefined });
	}
	for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g))
		at(m, { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
	for (const m of text.matchAll(
		/(?<![\d-])(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}|\d{2}))?(?![\d])/g,
	)) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		const [day, month] = order === 'DMY' ? [a, b] : [b, a];
		const y = m[3] ? Number(m[3]) : undefined;
		at(m, { day, month, year: y === undefined ? undefined : y < 100 ? 2000 + y : y });
	}
	return found;
}

/** The date a day and month name: the given year, else the one nearest to today. */
function resolve(found: DateFound, today: Temporal.PlainDate): Temporal.PlainDate | null {
	const make = (year: number) => {
		try {
			return Temporal.PlainDate.from(
				{ year, month: found.month, day: found.day },
				{ overflow: 'reject' },
			);
		} catch {
			return null;
		}
	};
	if (found.year !== undefined) return make(found.year);
	const candidates = [today.year - 1, today.year, today.year + 1]
		.map(make)
		.filter((d): d is Temporal.PlainDate => d !== null);
	const distance = (d: Temporal.PlainDate) => Math.abs(today.until(d).days);
	return candidates.toSorted((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** Only spaces and punctuation stand between a weekday and its date ("Wednesday, 20 October"). */
const ADJACENT = /^[\s,.(]{0,3}$/u;

/**
 * The weekdays a text names right next to a date that falls on another weekday
 * ("Wednesday 20 October" when 20 October is a Tuesday). A date without a year is the one
 * nearest to `today`.
 */
export function weekdayMismatches(
	text: string,
	today: string,
	words: DateWords,
	order: DateOrder = 'DMY',
): WeekdayMismatch[] {
	const clean = withoutTimes(text, words);
	const weekdays = [
		...namesIn(clean, words.weekdays, () => false),
		...namesIn(clean, words.weekdaysShort, () => true),
	];
	if (weekdays.length === 0) return [];
	const dates = datesIn(clean, words, order).filter(
		(d) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31,
	);
	const now = Temporal.PlainDate.from(today);
	const out: WeekdayMismatch[] = [];
	const seen = new Set<string>();
	for (const weekday of weekdays) {
		for (const found of dates) {
			const gap =
				found.start >= weekday.end
					? clean.slice(weekday.end, found.start)
					: weekday.start >= found.end
						? clean.slice(found.end, weekday.start)
						: null;
			if (gap === null || !ADJACENT.test(gap)) continue;
			const date = resolve(found, now);
			if (!date || date.dayOfWeek === weekday.value) continue;
			const key = `${date}:${weekday.value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const start = Math.min(weekday.start, found.start);
			const end = Math.max(weekday.end, found.end);
			out.push({
				said: text.slice(start, end).trim(),
				date: date.toString(),
				saidWeekday: weekday.value,
				weekday: date.dayOfWeek,
			});
		}
	}
	return out;
}

/** A weekday a person named with no date ("on Thursday"). */
export interface BareWeekday {
	/** The name, as written. */
	said: string;
	/** The weekday it names (1 = Monday … 7 = Sunday). */
	weekday: number;
}

/**
 * The weekdays a text names by their full names when it writes no date at all ("remind me on
 * Thursday"), once each. A text that also writes a date is left alone: its weekdays may belong to
 * that date, or to a title ("Sunday planning on 25 October"), and `weekdayMismatches` judges them.
 */
export function bareWeekdays(
	text: string,
	words: DateWords,
	order: DateOrder = 'DMY',
): BareWeekday[] {
	const clean = withoutTimes(text, words);
	if (datesIn(clean, words, order).length > 0) return [];
	const out: BareWeekday[] = [];
	for (const found of namesIn(clean, words.weekdays, () => false)) {
		if (out.some((d) => d.weekday === found.value)) continue;
		out.push({ said: text.slice(found.start, found.end), weekday: found.value });
	}
	return out;
}

/**
 * The clock times a text writes with minutes or a 12-hour mark ("18:30", "6.30", "6:30 pm",
 * "6pm"), as `HH:MM` (24-hour). A bare hour ("at 6") is left out: whether it is morning or
 * evening is not written.
 */
export function clockTimes(text: string): string[] {
	const out: string[] = [];
	const add = (hour: number, minute: number, mark: string | undefined) => {
		const pm = mark?.toLowerCase().startsWith('p');
		const h = mark ? (hour % 12) + (pm ? 12 : 0) : hour;
		if (h > 23 || minute > 59 || (mark && (hour < 1 || hour > 12))) return;
		out.push(`${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
	};
	const blanked = text.replace(
		/(?<![\d.:])(\d{1,2})[:.](\d{2})(?![\d.:])\s*(am|pm|a\.m\.|p\.m\.)?/giu,
		(_, h: string, m: string, mark: string | undefined) => {
			add(Number(h), Number(m), mark);
			return ' ';
		},
	);
	for (const m of blanked.matchAll(/(?<![\d.:])(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/giu))
		add(Number(m[1]), 0, m[2]);
	return out;
}
