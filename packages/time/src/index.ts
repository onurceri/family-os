import { Temporal } from 'temporal-polyfill';

export {
	type BareWeekday,
	bareWeekdays,
	clockTimes,
	correctWeekdays,
	type DateOrder,
	type DateWords,
	dateWords,
	dayNamedIn,
	isUncertainDate,
	type NamedDay,
	namedMonths,
	namedWeekdays,
	type WeekdayMismatch,
	weekdayMismatches,
	writtenDates,
} from './date-words.ts';
export {
	addDays,
	compareDates,
	DAY_MS,
	dayBounds,
	daysBetween,
	epochOf,
	HOUR_MS,
	IsoDateSchema,
	IsoTimeSchema,
	isValidDate,
	isValidTimeZone,
	MINUTE_MS,
	TimeZoneSchema,
	todayIn,
	zoned,
} from './dates.ts';
export {
	daysAround,
	describeRecurrence,
	formatDate,
	orderedWeekdays,
	type RelativeDayWords,
	relativeDayLabel,
	WeekStartSchema,
	weekdayNames,
	weekOf,
} from './display.ts';
export {
	type DateSeries,
	expandDates,
	expandTimed,
	firstRepeatDate,
	followingDays,
	fromRRule,
	nextDate,
	onlyThisDate,
	type Recurrence,
	RecurrenceSchema,
	type RepeatChoices,
	type RepeatEdit,
	repeatChoices,
	repeatEditAsks,
	type TimedSeries,
	toRRule,
	WEEKDAYS,
	type Weekday,
	weekdayOf,
	weekdaysAfterDateChange,
} from './recurrence.ts';
export {
	canonicalLocale,
	dateLocale,
	defaultHourCycle,
	defaultTemperatureUnit,
	defaultWeekStart,
	formatClock,
	formatLocaleForLanguage,
	formatTime,
	type HourCycle,
	isFormatLocale,
	numericDateOrder,
	regionFormats,
	setupFormatLocale,
	type TemperatureUnit,
} from './region-formats.ts';
export {
	everyFromRule,
	everyToRule,
	firstWeekday,
	lastDayOfMonth,
	type MonthlyOrYearly,
	nextEveryDue,
	type RepeatParts,
	type RepeatRule,
	repeatRule,
} from './repeat-rules.ts';
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
export { isWetCode, type WeatherKind, weatherKind } from './weather.ts';
/**
 * Time and recurrence for FamilyOS. Everything date-related goes through here:
 * - instants are epoch milliseconds (UTC) with an IANA time zone alongside,
 * - all-day dates are `YYYY-MM-DD` strings and are never converted to instants,
 * - recurrence is stored as RFC 5545 RRULE text and expanded with rrule-temporal.
 * Temporal comes from a polyfill until Node ships it natively.
 */
export { Temporal };
