import { correctWeekdays, type DateOrder, type DateWords, weekdayMismatches } from '@famos/time';

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
