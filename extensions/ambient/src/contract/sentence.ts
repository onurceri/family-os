import {
	addDays,
	dayBounds,
	epochOf,
	formatTime,
	HOUR_MS,
	type HourCycle,
	todayIn,
} from '@famos/time';
import type { Forecast, ForecastHour } from './index.ts';

/**
 * The weather sentence on Today: a template, not a model.
 * A pure function picks one catalog key per shape from the hourly forecast and the day's timed
 * items, and gives its params already formatted in the family's format locale and hour cycle.
 * The words live in the ambient catalog; code holds none.
 *
 * It links the weather to an item by time only ("during Football"); it never claims an item is
 * outdoors.
 */

export type WeatherSentenceKey =
	| 'wx_say_rain_from_event'
	| 'wx_say_rain_from'
	| 'wx_say_rain_until'
	| 'wx_say_rain_all_day'
	| 'wx_say_snow_from'
	| 'wx_say_storm_from'
	| 'wx_say_dry_sunny'
	| 'wx_say_dry'
	| 'wx_say_cold_morning'
	| 'wx_say_evening';

/** What the sky does after a rain window ends: the `{{label}}` of `wx_say_rain_until`. */
export type WeatherThenKey =
	| 'wx_then_clear'
	| 'wx_then_partly_cloudy'
	| 'wx_then_cloudy'
	| 'wx_then_fog'
	| 'wx_then_dry';

export interface WeatherSentence {
	key: WeatherSentenceKey;
	/** Formatted values for the key's `{{placeholders}}` (times, temperatures, an item's title). */
	params: Record<string, string>;
	/** For `wx_say_rain_until`: the key whose text fills `{{label}}`. */
	label?: WeatherThenKey;
}

/** A timed item of the day: its title and start only. */
export interface SentenceItem {
	title: string;
	start: number;
}

export interface SentenceFormat {
	timeZone: string;
	/** Degrees: the family's region format. */
	formatLocale: string;
	/** Clock times: the reader's words with the region's order (`dateLocale` in `@famos/time`). */
	dateLocale: string;
	hourCycle?: HourCycle | undefined;
}

/** A rain window: hours with a rain code or at least this chance of rain. */
const WET_PROBABILITY = 50;
/** "Cold morning": before this hour, and the day warms by at least the swing below. */
const MORNING_UNTIL = '10:00';
const COLD_SWING = { celsius: 8, fahrenheit: 14 } as const;
/** The evening begins at 20:00, or at 17:00 once the day's last timed item has started. */
const EVENING_FROM = '20:00';
const EVENING_EARLIEST = '17:00';
/** "Tonight" ends at this hour of the next morning. */
const NIGHT_UNTIL = '06:00';

const isRain = (code: number) =>
	(code >= 51 && code <= 57) || (code >= 61 && code <= 67) || (code >= 80 && code <= 82);
const isSnow = (code: number) => (code >= 71 && code <= 77) || code === 85 || code === 86;
const isStorm = (code: number) => code >= 95 && code <= 99;
const isClear = (code: number) => code === 0 || code === 1;
const isWet = (h: ForecastHour) =>
	isRain(h.code) ||
	isSnow(h.code) ||
	isStorm(h.code) ||
	(h.precipitationProbability ?? 0) >= WET_PROBABILITY;

function thenKey(code: number | undefined): WeatherThenKey {
	if (code === undefined) return 'wx_then_dry';
	if (isClear(code)) return 'wx_then_clear';
	if (code === 2) return 'wx_then_partly_cloudy';
	if (code === 3) return 'wx_then_cloudy';
	if (code === 45 || code === 48) return 'wx_then_fog';
	return 'wx_then_dry';
}

/** The first hour with the highest temperature. */
function warmest(hours: readonly ForecastHour[]): ForecastHour {
	return hours.reduce((best, h) => (h.temperature > best.temperature ? h : best));
}

export function weatherSentence(
	forecast: Pick<Forecast, 'temperature' | 'unit'> & { hourly?: readonly ForecastHour[] },
	items: readonly SentenceItem[],
	now: number,
	format: SentenceFormat,
): WeatherSentence | null {
	const { timeZone, formatLocale, dateLocale, hourCycle } = format;
	const hourly = (forecast.hourly ?? []).toSorted((a, b) => a.at - b.at);
	const today = todayIn(timeZone, now);
	const { start: dayStart, end: dayEnd } = dayBounds(today, timeZone);
	// The hour under way counts as now.
	const ahead = hourly.filter((h) => h.at + HOUR_MS > now);
	const rest = ahead.filter((h) => h.at < dayEnd);
	if (rest.length === 0) return null;

	const time = (at: number) => formatTime(at, timeZone, dateLocale, hourCycle);
	const number = new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 0 });
	const degrees = (value: number) => number.format(Math.round(value) || 0);
	const at = (clock: string, date = today) => epochOf(date, clock, timeZone);

	const todays = items
		.filter((i) => i.start >= dayStart && i.start < dayEnd)
		.toSorted((a, b) => a.start - b.start);
	const last = todays.at(-1);

	// The evening: what is left is the night.
	const evening =
		now >= at(EVENING_FROM) ||
		(last !== undefined && last.start <= now && now >= at(EVENING_EARLIEST));
	if (evening) {
		const nightEnd = at(NIGHT_UNTIL, addDays(today, 1));
		const night = ahead.filter((h) => h.at < nightEnd);
		const min = Math.min(...night.map((h) => h.temperature));
		return {
			key: 'wx_say_evening',
			params: { temp: degrees(forecast.temperature), min: degrees(min) },
		};
	}

	const peak = warmest(rest);
	const firstWet = ahead.findIndex((h) => h.at < dayEnd && isWet(h));
	if (firstWet >= 0) {
		let next = firstWet;
		while (next < ahead.length && isWet(ahead[next] as ForecastHour)) next++;
		const window = ahead.slice(firstWet, next);
		const start = (window[0] as ForecastHour).at;
		const end = (window.at(-1) as ForecastHour).at + HOUR_MS;
		const storms = window.filter((h) => isStorm(h.code)).length;
		const snows = window.filter((h) => isSnow(h.code)).length;
		const rains = window.filter((h) => isRain(h.code)).length;
		if (storms > 0) return { key: 'wx_say_storm_from', params: { time: time(start) } };
		if (snows > 0 && snows >= rains)
			return { key: 'wx_say_snow_from', params: { time: time(start) } };
		if (firstWet === 0) {
			if (end >= dayEnd)
				return { key: 'wx_say_rain_all_day', params: { max: degrees(peak.temperature) } };
			return {
				key: 'wx_say_rain_until',
				params: { time: time(end) },
				label: thenKey(ahead[next]?.code),
			};
		}
		const during = todays.find((i) => i.start >= now && i.start >= start && i.start < end);
		if (during) {
			return { key: 'wx_say_rain_from_event', params: { time: time(start), event: during.title } };
		}
		return { key: 'wx_say_rain_from', params: { time: time(start), end: time(end) } };
	}

	const swing = peak.temperature - forecast.temperature;
	if (now < at(MORNING_UNTIL) && swing >= COLD_SWING[forecast.unit]) {
		return {
			key: 'wx_say_cold_morning',
			params: {
				min: degrees(forecast.temperature),
				max: degrees(peak.temperature),
				time: time(peak.at),
			},
		};
	}
	const params = { max: degrees(peak.temperature), time: time(peak.at) };
	if (rest.every((h) => isClear(h.code))) return { key: 'wx_say_dry_sunny', params };
	return { key: 'wx_say_dry', params };
}
