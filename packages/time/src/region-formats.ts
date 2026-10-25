import { TIME } from './dates.ts';

// Region formats: derived from a BCP 47 format locale, never from the UI language. Dates and
// times join the two in `dateLocale`.

export type HourCycle = 'h12' | 'h23';
export type TemperatureUnit = 'celsius' | 'fahrenheit';

/** Whether the text is a well-formed BCP 47 language tag. */
export function isFormatLocale(tag: string): boolean {
	try {
		return Intl.getCanonicalLocales(tag).length === 1;
	} catch {
		return false;
	}
}

/** The canonical form of a tag, or `fallback` when it is not valid. */
export function canonicalLocale(tag: string, fallback = 'en-US'): string {
	try {
		return Intl.getCanonicalLocales(tag)[0] ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * A format locale for families that only chose a language (before region formats existed): the
 * language's most likely region, from `Intl` (`tr` → `tr-TR`, `en` → `en-US`).
 */
export function formatLocaleForLanguage(language: string): string {
	try {
		const region = new Intl.Locale(language).maximize().region;
		const base = new Intl.Locale(language).language;
		return region ? `${base}-${region}` : 'en-US';
	} catch {
		return 'en-US';
	}
}

/**
 * The starting region format at setup: the browser's own (`en-US`), since the words come from
 * the language and never from the region format. A browser without a region gets the chosen
 * language's most likely one (`tr` → `tr-TR`).
 */
export function setupFormatLocale(language: string, browserLocale: string): string {
	try {
		const browser = new Intl.Locale(browserLocale);
		if (browser.region) return browser.toString();
	} catch {
		// fall through to the language's own region
	}
	return formatLocaleForLanguage(language);
}

/** Whether `Intl` holds date data for a language as used in `region` (`en-SI` yes, `tr-US` no). */
function hasRegionData(tag: string, region: string): boolean {
	const resolved = new Intl.DateTimeFormat(tag).resolvedOptions().locale;
	return new Intl.Locale(resolved).maximize().region === region;
}

const dateLocales = new Map<string, string>();

/**
 * The locale to write dates and times with, for people who read `language` in a family whose
 * region format is `formatLocale`. Day and month names, "PM" and the like are always words of
 * the language; the region's order comes with them wherever `Intl` knows that language as used
 * in that region (English with `sl-SI` gives "Thu, 22 Oct" and 22/10/2026; Slovenian gives
 * "čet., 22. okt."). Where it does not (Turkish with `en-US`), the language's own phrasing is
 * kept rather than showing words of a language the reader did not choose. The family's hour
 * cycle, and the calendar and digits the region tag names, are part of the result. Numbers and
 * money have no words and keep `formatLocale` itself.
 */
export function dateLocale(language: string, formatLocale: string, hourCycle?: HourCycle): string {
	const key = `${language}|${formatLocale}|${hourCycle ?? ''}`;
	const cached = dateLocales.get(key);
	if (cached) return cached;
	let tag: string;
	try {
		const words = new Intl.Locale(language);
		const format = new Intl.Locale(formatLocale);
		const region = format.region ?? format.maximize().region;
		let base = words.baseName;
		if (words.language === format.language && (!words.script || words.script === format.script))
			base = format.baseName;
		else if (region) {
			const both = new Intl.Locale(words.language, {
				...(words.script && { script: words.script }),
				region,
			}).baseName;
			if (hasRegionData(both, region)) base = both;
		}
		tag = new Intl.Locale(base, {
			...(hourCycle && { hourCycle }),
			...(format.calendar && { calendar: format.calendar }),
			...(format.numberingSystem && { numberingSystem: format.numberingSystem }),
		}).toString();
	} catch {
		tag = formatLocale;
	}
	dateLocales.set(key, tag);
	return tag;
}

let regionList: readonly string[] | undefined;

/**
 * Every region `Intl` knows as a place, each with its most likely language (`sl-SI`, `en-US`,
 * `pt-BR`): the region formats to choose from. A region counts as a place when `Intl` holds
 * locale data for it or lists time zones in it, which leaves out groupings (`EU`, `UN`), test
 * regions and retired codes. Any other valid tag can still be typed.
 */
export function regionFormats(): readonly string[] {
	if (regionList) return regionList;
	const names = new Intl.DisplayNames('en', { type: 'region', fallback: 'none' });
	const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
	const found: string[] = [];
	for (const a of letters) {
		for (const b of letters) {
			const region = `${a}${b}`;
			try {
				if (!names.of(region)) continue;
				const likely = new Intl.Locale(`und-${region}`).maximize() as Intl.Locale & {
					getTimeZones?: () => string[] | undefined;
				};
				if (likely.region !== region || likely.language === 'und') continue;
				const tag = `${likely.language}-${region}`;
				if (hasRegionData(tag, region) || (likely.getTimeZones?.()?.length ?? 0) > 0)
					found.push(tag);
			} catch {
				// not a region this runtime knows
			}
		}
	}
	regionList = found;
	return found;
}

/** First day of the week of a region, from `Intl.Locale` week info (1 = Monday), else Monday. */
export function defaultWeekStart(formatLocale: string): number {
	try {
		const locale = new Intl.Locale(formatLocale) as Intl.Locale & {
			getWeekInfo?: () => { firstDay: number };
			weekInfo?: { firstDay: number };
		};
		const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
		return typeof first === 'number' && first >= 1 && first <= 7 ? first : 1;
	} catch {
		return 1;
	}
}

/** 12- or 24-hour clock of a region, from `Intl`. */
export function defaultHourCycle(formatLocale: string): HourCycle {
	try {
		const cycle = new Intl.DateTimeFormat(formatLocale, { hour: 'numeric' }).resolvedOptions()
			.hourCycle;
		return cycle === 'h11' || cycle === 'h12' ? 'h12' : 'h23';
	} catch {
		return 'h23';
	}
}

/** Regions that use Fahrenheit for weather (a short documented list; everyone else Celsius). */
const FAHRENHEIT_REGIONS = new Set([
	'US',
	'LR',
	'MM',
	'BS',
	'BZ',
	'KY',
	'PW',
	'FM',
	'MH',
	'GU',
	'PR',
	'VI',
	'AS',
	'MP',
]);

export function defaultTemperatureUnit(formatLocale: string): TemperatureUnit {
	try {
		const region = new Intl.Locale(formatLocale).maximize().region;
		return region && FAHRENHEIT_REGIONS.has(region) ? 'fahrenheit' : 'celsius';
	} catch {
		return 'celsius';
	}
}

/** Order of day, month and year in an all-numeric date of a region: `DMY`, `MDY` or `YMD`. */
export function numericDateOrder(formatLocale: string): 'DMY' | 'MDY' | 'YMD' {
	try {
		const parts = new Intl.DateTimeFormat(formatLocale, {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			timeZone: 'UTC',
		}).formatToParts(Date.UTC(2026, 10, 25));
		const order = parts
			.map((p) =>
				p.type === 'day' ? 'D' : p.type === 'month' ? 'M' : p.type === 'year' ? 'Y' : '',
			)
			.join('');
		return order === 'MDY' || order === 'YMD' ? order : 'DMY';
	} catch {
		return 'DMY';
	}
}

/** A clock time for display, with a `dateLocale` and the family's hour cycle. */
export function formatTime(
	at: number,
	timeZone: string,
	locale: string,
	hourCycle?: HourCycle,
): string {
	return new Intl.DateTimeFormat(locale, {
		hour: hourCycle === 'h12' ? 'numeric' : '2-digit',
		minute: '2-digit',
		timeZone,
		...(hourCycle && { hourCycle }),
	}).format(at);
}

/** A local time of day (`HH:MM`) for display, with a `dateLocale` and the family's hour cycle. */
export function formatClock(time: string, locale: string, hourCycle?: HourCycle): string {
	if (!TIME.test(time)) return time;
	return new Intl.DateTimeFormat(locale, {
		hour: hourCycle === 'h12' ? 'numeric' : '2-digit',
		minute: '2-digit',
		timeZone: 'UTC',
		...(hourCycle && { hourCycle }),
	}).format(Date.parse(`2026-01-05T${time}:00Z`));
}
