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
export function weekdayNames(locale: string): Record<Weekday, string> {
	const monday = Date.parse('2026-01-05T12:00:00Z'); // a Monday
	const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
	return Object.fromEntries(
		WEEKDAYS.map((w, i) => [w, fmt.format(monday + i * 86_400_000)]),
	) as Record<Weekday, string>;
}

// Region formats: derived from a BCP 47 format locale, never from the UI language.

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
 * The starting region format at setup: the chosen language's words with the browser's region
 * (Turkish chosen in an `en-US` browser gives `tr-US`: Turkish day and month names, the United
 * States' first day of the week). A browser already in that language keeps its own locale.
 */
export function setupFormatLocale(language: string, browserLocale: string): string {
	try {
		const chosen = new Intl.Locale(language).language;
		const browser = new Intl.Locale(browserLocale);
		if (browser.language === chosen) return browser.toString();
		if (browser.region) {
			const tag = Intl.getCanonicalLocales(`${chosen}-${browser.region}`)[0];
			if (tag) return tag;
		}
	} catch {
		// fall through to the language's own region
	}
	return formatLocaleForLanguage(language);
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

/** A clock time for display, in the family's format locale and hour cycle. */
export function formatTime(
	at: number,
	timeZone: string,
	formatLocale: string,
	hourCycle?: HourCycle,
): string {
	return new Intl.DateTimeFormat(formatLocale, {
		hour: hourCycle === 'h12' ? 'numeric' : '2-digit',
		minute: '2-digit',
		timeZone,
		...(hourCycle && { hourCycle }),
	}).format(at);
}

/** A local time of day (`HH:MM`) for display, in the family's format locale and hour cycle. */
export function formatClock(time: string, formatLocale: string, hourCycle?: HourCycle): string {
	if (!TIME.test(time)) return time;
	return new Intl.DateTimeFormat(formatLocale, {
		hour: hourCycle === 'h12' ? 'numeric' : '2-digit',
		minute: '2-digit',
		timeZone: 'UTC',
		...(hourCycle && { hourCycle }),
	}).format(Date.parse(`2026-01-05T${time}:00Z`));
}

type RecurrenceT = (
	key: 'repeat_daily' | 'repeat_weekly' | 'repeat_monthly' | 'repeat_until',
	options?: Record<string, unknown>,
) => string;

export function describeRecurrence(
	rec: Recurrence,
	t: RecurrenceT,
	locale: string,
	weekStart = 1,
): string {
	let text =
		rec.freq === 'daily'
			? t('repeat_daily')
			: rec.freq === 'monthly'
				? t('repeat_monthly')
				: t('repeat_weekly');
	if (rec.freq === 'weekly') {
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

export {
	type BareWeekday,
	bareWeekdays,
	clockTimes,
	type DateOrder,
	type DateWords,
	dateWords,
	isUncertainDate,
	type WeekdayMismatch,
	weekdayMismatches,
} from './date-words.ts';
