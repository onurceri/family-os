import {
	correctWeekdays,
	type DateOrder,
	type DateWords,
	formatDate,
	isValidDate,
	weekdayMismatches,
} from '@famos/time';

/** A weekday's names in one language, from its catalog: full names, then short ones. */
type WeekdayNames = { full: readonly string[]; short: readonly string[] }[];

const range7 = [1, 2, 3, 4, 5, 6, 7];

const listOf = (text: string) =>
	text
		.split(',')
		.map((w) => w.trim())
		.filter((w) => w !== '');

/** The weekday names of a language (index 0 = Monday), read from its catalog. */
function namesIn(locale: string, translate: (locale: string, key: string) => string): WeekdayNames {
	return range7.map((n) => ({
		full: listOf(translate(locale, `app:words_weekday_${n}`)),
		short: listOf(translate(locale, `app:words_weekday_short_${n}`)),
	}));
}

/**
 * The answer with each weekday written next to a date of another weekday corrected to the date's
 * real one ("Monday 20 October" → "Tuesday 20 October"): models copy the date from a tool and
 * work its weekday out themselves. The word comes from the catalog of the language the wrong one
 * is in (the first of `locales` whose names hold it), full or short as it was written; a word of
 * none of them is left alone. A weekday and date the person wrote that way themselves stay as
 * they are: the answer quotes them to say they do not match.
 */
export function answerWithRealWeekdays(
	text: string,
	options: {
		today: string;
		words: DateWords;
		order: DateOrder;
		/** What the person wrote, whose own mismatches the answer may quote. */
		asked: string;
		/** The languages the answer may be in, most likely first. */
		locales: readonly string[];
		translate: (locale: string, key: string) => string;
	},
): string {
	const languages = [...new Set(options.locales)].map((locale) =>
		namesIn(locale, options.translate),
	);
	const quoted = new Set(
		weekdayMismatches(options.asked, options.today, options.words, options.order).map(
			(m) => `${m.date}:${m.saidWeekday}`,
		),
	);
	const fixed = correctWeekdays(
		text,
		options.today,
		options.words,
		options.order,
		({ date, saidWeekday, weekday }, said) => {
			if (quoted.has(`${date}:${saidWeekday}`)) return null;
			const word = said.toLocaleLowerCase();
			for (const names of languages) {
				const short = names.some((n) => n.short.some((w) => w.toLocaleLowerCase() === word));
				const full = names.some((n) => n.full.some((w) => w.toLocaleLowerCase() === word));
				if (!full && !short) continue;
				const real = names[weekday - 1];
				return (full ? real?.full[0] : real?.short[0]) ?? null;
			}
			return null;
		},
	);
	return fixed.text;
}

/** An ISO date as models write it, also with the non-breaking hyphens some of them type. */
const ISO_IN_TEXT = /(?<![\d\p{L}])(\d{4})[-‐‑](\d{2})[-‐‑](\d{2})(?![\d\p{L}])/gu;

const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The answer with each ISO date ("2026-10-20") written as words in the reader's date locale
 * ("Tuesday, 20 October"; the year only when it is not this year): models copy dates from tool
 * results whatever they are told. A weekday word right before it ("Tuesday 2026-10-20") is the
 * model's own and is dropped, since the words name the weekday. A date the person wrote that way
 * themselves stays as it is.
 */
export function answerWithWordDates(
	text: string,
	options: {
		today: string;
		/** What the person wrote. */
		asked: string;
		/** `dateLocale(language, formatLocale, hourCycle)` of the reader. */
		dateLocale: string;
		/** Weekday names (full and short) of every installed language. */
		weekdays: readonly string[];
	},
): string {
	const own = new Set(
		[...options.asked.matchAll(ISO_IN_TEXT)].map((m) => `${m[1]}-${m[2]}-${m[3]}`),
	);
	const names = options.weekdays.filter(Boolean).toSorted((a, b) => b.length - a.length);
	const before =
		names.length > 0
			? new RegExp(`(?<!\\p{L})(?:${names.map(escapeRegex).join('|')})\\.?,?\\s+$`, 'iu')
			: null;
	let out = '';
	let last = 0;
	for (const match of text.matchAll(ISO_IN_TEXT)) {
		const date = `${match[1]}-${match[2]}-${match[3]}`;
		if (own.has(date) || !isValidDate(date)) continue;
		let head = text.slice(last, match.index);
		const weekday = before?.exec(head);
		if (weekday) head = head.slice(0, weekday.index);
		out += head;
		out += formatDate(date, options.dateLocale, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			...(date.slice(0, 4) !== options.today.slice(0, 4) && { year: 'numeric' }),
		});
		last = match.index + match[0].length;
	}
	return out + text.slice(last);
}
