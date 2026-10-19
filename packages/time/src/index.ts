import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';

/**
 * Time and recurrence for FamilyOS. Everything date-related goes through here:
 * - instants are epoch milliseconds (UTC) with an IANA time zone alongside,
 * - all-day dates are `YYYY-MM-DD` strings and are never converted to instants,
 * - recurrence is stored as RFC 5545 RRULE text and expanded with rrule-temporal.
 * Temporal comes from a polyfill until Node ships it natively.
 */
export { Temporal };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(value: string): boolean {
	if (!DATE.test(value)) return false;
	try {
		Temporal.PlainDate.from(value, { overflow: 'reject' });
		return true;
	} catch {
		return false;
	}
}

export function isValidTimeZone(value: string): boolean {
	try {
		Temporal.Now.zonedDateTimeISO(value);
		return true;
	} catch {
		return false;
	}
}

export const IsoDateSchema = z.string().refine(isValidDate, 'Expected a date as YYYY-MM-DD');
export const IsoTimeSchema = z.string().regex(TIME, 'Expected a time as HH:MM');
export const TimeZoneSchema = z.string().refine(isValidTimeZone, 'Unknown time zone');

/** Today's date (`YYYY-MM-DD`) in a time zone. */
export function todayIn(timeZone: string, now: number): string {
	return Temporal.Instant.fromEpochMilliseconds(now)
		.toZonedDateTimeISO(timeZone)
		.toPlainDate()
		.toString();
}

export function zoned(epochMs: number, timeZone: string): Temporal.ZonedDateTime {
	return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
}

/** The instant of a local date and time in a zone. Ambiguous/skipped times resolve like calendars do. */
export function epochOf(date: string, time: string, timeZone: string): number {
	return Temporal.PlainDateTime.from(`${date}T${time}`)
		.toZonedDateTime(timeZone, { disambiguation: 'compatible' })
		.toInstant().epochMilliseconds;
}

/** Start (inclusive) and end (exclusive) of a local day, as instants. A DST day lasts 23 or 25 hours. */
export function dayBounds(date: string, timeZone: string): { start: number; end: number } {
	const day = Temporal.PlainDate.from(date);
	return {
		start: day.toZonedDateTime({ timeZone }).toInstant().epochMilliseconds,
		end: day.add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant().epochMilliseconds,
	};
}

export function addDays(date: string, days: number): string {
	return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function compareDates(a: string, b: string): number {
	return Temporal.PlainDate.compare(Temporal.PlainDate.from(a), Temporal.PlainDate.from(b));
}

/* ───────────────────────── Recurrence ───────────────────────── */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The weekday code (`MO` … `SU`) of an ISO date. */
export const weekdayOf = (date: string): Weekday =>
	WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1] as Weekday;

/**
 * The weekly repeat days after the date moved from `previousDate` to `nextDate`. A repeat that
 * is empty, or only held the old date's weekday, follows the date. Days the person chose
 * themselves are never dropped: the new date's weekday is added to them, so a weekly series
 * always includes the day it starts on. An incomplete date changes nothing. A `saved` item is
 * never changed by a date change: moving the start of "every Tuesday" leaves it as it is.
 */
export function weekdaysAfterDateChange(
	byDay: readonly string[],
	previousDate: string,
	nextDate: string,
	saved = false,
): string[] {
	if (saved || !ISO_DATE.test(nextDate)) return [...byDay];
	const next = weekdayOf(nextDate);
	if (byDay.includes(next)) return [...byDay];
	const followsDate =
		byDay.length === 0 ||
		(byDay.length === 1 && ISO_DATE.test(previousDate) && byDay[0] === weekdayOf(previousDate));
	return followsDate ? [next] : [...byDay, next];
}

/**
 * The first date on or after `startDate` that falls on one of the weekly `byDay` codes: the day
 * a new weekly series first turns up. It is the start date itself when that matches. Null when
 * no day is chosen or the date is incomplete.
 */
export function firstRepeatDate(startDate: string, byDay: readonly string[]): string | null {
	if (!ISO_DATE.test(startDate) || !isValidDate(startDate)) return null;
	const chosen = new Set(byDay.filter((d) => (WEEKDAYS as readonly string[]).includes(d)));
	if (chosen.size === 0) return null;
	for (let i = 0; i < 7; i++) {
		const date = addDays(startDate, i);
		if (chosen.has(weekdayOf(date))) return date;
	}
	return null;
}

/** What a saved repeating item's form says about its schedule: the repeat, the date and the weekly days. */
export interface RepeatEdit {
	repeat: string;
	date: string;
	byDay: readonly string[];
}

const REPEATS = ['daily', 'weekly', 'monthly'];

/**
 * Whether saving a repeating item must ask "only this one" or "this one and the ones after":
 * its date moved, or its weekly days changed, while it stays a repeat.
 */
export function repeatEditAsks(before: RepeatEdit, after: RepeatEdit): boolean {
	if (!REPEATS.includes(before.repeat) || !REPEATS.includes(after.repeat)) return false;
	if (before.date !== after.date) return true;
	return (
		before.repeat === 'weekly' &&
		after.repeat === 'weekly' &&
		[...before.byDay].sort().join() !== [...after.byDay].sort().join()
	);
}

/**
 * The date "only this one" lands on: the date typed when it moved, otherwise (the days changed)
 * the first date on or after `from` that matches the new days.
 */
export function onlyThisDate(before: RepeatEdit, after: RepeatEdit, from: string): string {
	if (before.date !== after.date) return after.date;
	const start = isValidDate(from) && compareDates(from, after.date) > 0 ? from : after.date;
	return firstRepeatDate(start, after.byDay) ?? after.date;
}

/**
 * The weekly days of "this one and the ones after": a lone day that was the old date's weekday
 * moves to the new date's weekday; days the person chose are kept as the form shows them.
 */
export function followingDays(before: RepeatEdit, after: RepeatEdit): string[] {
	const lone =
		after.byDay.length === 1 &&
		isValidDate(before.date) &&
		isValidDate(after.date) &&
		after.byDay[0] === weekdayOf(before.date);
	return lone ? [weekdayOf(after.date)] : [...after.byDay];
}

/** What each answer to "only this one, or this one and the ones after" does. */
export interface RepeatChoices {
	/** Only this one: the date it lands on. */
	onlyDate: string;
	/** This one and the ones after: the weekly days from now on. */
	days: string[];
	/** This one and the ones after: the first date of the new series. */
	nextDate: string;
}

export function repeatChoices(before: RepeatEdit, after: RepeatEdit, from: string): RepeatChoices {
	const days = after.repeat === 'weekly' ? followingDays(before, after) : [...after.byDay];
	return {
		onlyDate: onlyThisDate(before, after, from),
		days,
		nextDate: (after.repeat === 'weekly' ? firstRepeatDate(after.date, days) : null) ?? after.date,
	};
}

/**
 * The recurrence presets the UI offers. Stored as RRULE text, so anything CalDAV can express
 * still round-trips; `fromRRule` returns null for rules outside these presets.
 */
export const RecurrenceSchema = z.discriminatedUnion('freq', [
	z.object({
		freq: z.literal('daily'),
		interval: z.number().int().min(1).max(365).default(1),
		until: IsoDateSchema.optional(),
	}),
	z.object({
		freq: z.literal('weekly'),
		interval: z.number().int().min(1).max(52).default(1),
		byDay: z.array(z.enum(WEEKDAYS)).min(1).max(7),
		until: IsoDateSchema.optional(),
	}),
	z.object({
		freq: z.literal('monthly'),
		interval: z.number().int().min(1).max(12).default(1),
		until: IsoDateSchema.optional(),
	}),
]);
export type Recurrence = z.infer<typeof RecurrenceSchema>;

const compact = (date: string) => date.replaceAll('-', '');

/**
 * RRULE text for a preset. `UNTIL` is inclusive of the whole last day. For timed series pass the
 * time zone: `UNTIL` is the end of that day there, in UTC as RFC 5545 requires. For date series
 * (all-day events, tasks) pass `null`: `UNTIL` is a plain date, like their DTSTART.
 */
export function toRRule(recurrence: Recurrence, timeZone: string | null): string {
	const parts = [`FREQ=${recurrence.freq.toUpperCase()}`];
	if (recurrence.interval > 1) parts.push(`INTERVAL=${recurrence.interval}`);
	if (recurrence.freq === 'weekly') {
		const days = [...new Set(recurrence.byDay)].sort(
			(a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b),
		);
		parts.push(`BYDAY=${days.join(',')}`);
	}
	if (recurrence.until && timeZone === null) {
		parts.push(`UNTIL=${compact(recurrence.until)}`);
	} else if (recurrence.until && timeZone !== null) {
		const end = Temporal.PlainDate.from(recurrence.until)
			.toPlainDateTime({ hour: 23, minute: 59, second: 59 })
			.toZonedDateTime(timeZone)
			.toInstant()
			.toZonedDateTimeISO('UTC');
		parts.push(
			`UNTIL=${compact(end.toPlainDate().toString())}T${end.toPlainTime().toString().slice(0, 8).replaceAll(':', '')}Z`,
		);
	}
	return parts.join(';');
}

/** The preset behind an RRULE, or null when the rule uses features the presets don't cover. */
export function fromRRule(rrule: string, timeZone: string): Recurrence | null {
	const fields = new Map(
		rrule
			.replace(/^RRULE:/, '')
			.split(';')
			.map((p) => p.split('=') as [string, string]),
	);
	const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL']);
	if ([...fields.keys()].some((k) => !allowed.has(k))) return null;
	const freq = fields.get('FREQ')?.toLowerCase();
	const interval = Number(fields.get('INTERVAL') ?? 1);
	let until: string | undefined;
	const rawUntil = fields.get('UNTIL');
	if (rawUntil) {
		const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(rawUntil);
		if (!m) return null;
		until = m[4]
			? Temporal.Instant.from(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
					.toZonedDateTimeISO(timeZone)
					.toPlainDate()
					.toString()
			: `${m[1]}-${m[2]}-${m[3]}`;
	}
	const base = { freq, interval, ...(until && { until }) };
	const candidate =
		freq === 'weekly'
			? { ...base, byDay: (fields.get('BYDAY') ?? '').split(',').filter(Boolean) }
			: fields.has('BYDAY')
				? null
				: base;
	const parsed = RecurrenceSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

export interface TimedSeries {
	startsAt: number;
	timeZone: string;
	rrule: string | null;
	/** Excluded occurrence starts (epoch ms). */
	exdates?: readonly number[];
}

/** Occurrence starts of a timed event within [from, to). A non-recurring event yields its start if inside. */
export function expandTimed(series: TimedSeries, from: number, to: number): number[] {
	if (!series.rrule)
		return series.startsAt >= from && series.startsAt < to ? [series.startsAt] : [];
	const rule = new RRuleTemporal({
		rruleString: series.rrule,
		dtstart: zoned(series.startsAt, series.timeZone),
	});
	const excluded = new Set(series.exdates ?? []);
	return rule
		.between(new Date(from), new Date(to - 1), true)
		.map((z) => z.toInstant().epochMilliseconds)
		.filter((ms) => ms >= from && ms < to && !excluded.has(ms));
}

export interface DateSeries {
	date: string;
	rrule: string | null;
	exdates?: readonly string[];
}

/**
 * Occurrence dates of an all-day series (or a recurring task) within [from, to] inclusive.
 * Dates are expanded on a UTC calendar, so no time zone can shift them.
 */
export function expandDates(series: DateSeries, from: string, to: string): string[] {
	if (!series.rrule) {
		return compareDates(series.date, from) >= 0 && compareDates(series.date, to) <= 0
			? [series.date]
			: [];
	}
	const rule = new RRuleTemporal({
		rruleString: series.rrule,
		dtstart: Temporal.PlainDate.from(series.date).toZonedDateTime({ timeZone: 'UTC' }),
	});
	const start = Temporal.PlainDate.from(from).toZonedDateTime({ timeZone: 'UTC' });
	const end = Temporal.PlainDate.from(to).toZonedDateTime({ timeZone: 'UTC' });
	const excluded = new Set(series.exdates ?? []);
	return rule
		.between(start, end, true)
		.map((z) => z.toPlainDate().toString())
		.filter((d) => !excluded.has(d));
}

/** The first occurrence date strictly after `after` (for rolling a recurring task forward). */
export function nextDate(series: DateSeries, after: string): string | null {
	if (!series.rrule) return null;
	const rule = new RRuleTemporal({
		rruleString: series.rrule,
		dtstart: Temporal.PlainDate.from(series.date).toZonedDateTime({ timeZone: 'UTC' }),
	});
	const next = rule.next(
		Temporal.PlainDate.from(after).toZonedDateTime({ timeZone: 'UTC' }),
		false,
	);
	return next ? next.toPlainDate().toString() : null;
}

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
	return Object.fromEntries(
		WEEKDAYS.map((w, i) => [w, fmt.format(monday + i * 86_400_000)]),
	) as Record<Weekday, string>;
}

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

export {
	type BareWeekday,
	bareWeekdays,
	clockTimes,
	correctWeekdays,
	type DateOrder,
	type DateWords,
	dateWords,
	isUncertainDate,
	namedMonths,
	namedWeekdays,
	type WeekdayMismatch,
	weekdayMismatches,
	writtenDates,
} from './date-words.ts';
export {
	type DayDirection,
	type DayDoubt,
	type DayParts,
	type DayResult,
	type ResolveDayOptions,
	resolveDay,
} from './resolve-day.ts';
export {
	type ResolvedSpan,
	type ResolveSpanOptions,
	resolveSpan,
	type SpanInput,
	type SpanLabel,
	type SpanLabelKey,
} from './resolve-span.ts';
