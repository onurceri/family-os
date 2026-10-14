import {
	defineRoute,
	type ExtensionContext,
	ExternalHttpError,
	FamosError,
	isExternalHttpError,
	isFamosError,
} from '@famos/sdk';
import type { TemperatureUnit } from '@famos/time';
import { z } from 'zod';
import {
	type Forecast,
	type ForecastHour,
	ForecastSchema,
	type Place,
	type PlaceResult,
	PlaceResultSchema,
	roundCoordinate,
	WeatherSchema,
} from '../contract/index.ts';
import { cachesFor, shared, WEATHER_TTL_MS } from './caches.ts';
import { ambientManage, ambientWeather } from './capabilities.ts';
import { loadSettings } from './store.ts';

/**
 * Weather from Open-Meteo: no key, free for non-commercial use, CC-BY (the display
 * shows the attribution). The server fetches it for coordinates rounded to two decimals and
 * caches the answer for 30 minutes; displays never call Open-Meteo themselves.
 */

const Current = z.object({
	current: z.object({
		temperature_2m: z.number(),
		weather_code: z.number(),
		is_day: z.number().optional(),
	}),
	daily: z.object({
		temperature_2m_max: z.array(z.number()).min(1),
		temperature_2m_min: z.array(z.number()).min(1),
		precipitation_probability_max: z.array(z.number().nullable()).optional(),
	}),
	/** Asked for with `timeformat=unixtime`: `time` is in seconds. Optional so a reply without it still works. */
	hourly: z
		.object({
			time: z.array(z.number()),
			temperature_2m: z.array(z.number().nullable()),
			weather_code: z.array(z.number().nullable()),
			precipitation_probability: z.array(z.number().nullable()).optional(),
		})
		.optional(),
});

export function forecastUrl(place: Place, unit: TemperatureUnit = 'celsius'): string {
	const params = new URLSearchParams({
		latitude: String(roundCoordinate(place.latitude)),
		longitude: String(roundCoordinate(place.longitude)),
		current: 'temperature_2m,weather_code,is_day',
		daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
		hourly: 'temperature_2m,weather_code,precipitation_probability',
		timezone: 'auto',
		timeformat: 'unixtime',
		// Two days, so the evening can speak about the night.
		forecast_days: '2',
		...(unit === 'fahrenheit' && { temperature_unit: 'fahrenheit' }),
	});
	return `https://api.open-meteo.com/v1/forecast?${params}`;
}

/** Open-Meteo's answer as a `Forecast`, or null when it does not have the expected shape. */
export function parseForecast(
	text: string,
	place: Place,
	unit: TemperatureUnit,
	fetchedAt: number,
): Forecast | null {
	const parsed = Current.safeParse(JSON.parse(text));
	if (!parsed.success) return null;
	const { current, daily, hourly } = parsed.data;
	const hours: ForecastHour[] = [];
	for (const [i, seconds] of (hourly?.time ?? []).entries()) {
		const temperature = hourly?.temperature_2m[i];
		const code = hourly?.weather_code[i];
		// Hours the model has no value for yet are left out rather than guessed.
		if (temperature == null || code == null) continue;
		hours.push({
			at: seconds * 1000,
			temperature,
			code: Math.trunc(code),
			precipitationProbability: hourly?.precipitation_probability?.[i] ?? null,
		});
	}
	return {
		temperature: current.temperature_2m,
		unit,
		weatherCode: Math.trunc(current.weather_code),
		isDay: current.is_day !== 0,
		min: daily.temperature_2m_min[0] as number,
		max: daily.temperature_2m_max[0] as number,
		precipitationProbability: daily.precipitation_probability_max?.[0] ?? null,
		place: place.name,
		fetchedAt,
		hourly: hours,
	};
}

function unavailable(error: unknown): FamosError {
	if (isFamosError(error)) return error;
	return new FamosError(
		'unavailable',
		`weather_${isExternalHttpError(error) ? error.code : 'unreachable'}`,
	);
}

async function fetchForecast(
	ctx: ExtensionContext,
	place: Place,
	unit: TemperatureUnit,
): Promise<Forecast> {
	try {
		const response = await ctx.http.get({
			url: forecastUrl(place, unit),
			headers: { accept: 'application/json' },
			maxBytes: 256 * 1024,
			timeoutMs: 15_000,
		});
		if (response.status !== 200) throw new ExternalHttpError('unreachable');
		const forecast = parseForecast(response.text, place, unit, ctx.clock.now());
		if (!forecast) throw new FamosError('unavailable', 'weather_bad_response');
		return forecast;
	} catch (error) {
		throw unavailable(error instanceof SyntaxError ? new ExternalHttpError('unreachable') : error);
	}
}

export const getWeather = defineRoute({
	method: 'get',
	path: '/weather',
	operationId: 'ambient.getWeather',
	summary: 'Today’s weather for the configured place (cached 30 minutes); enabled:false when off',
	requires: ambientWeather.id,
	response: WeatherSchema,
	async handle(ctx) {
		const { settings, version } = await loadSettings(ctx.db);
		const { weather, timing } = settings;
		// Off is a normal state, not an error: the widget simply stays away.
		if (!weather.enabled || !weather.place) return { enabled: false, timing, forecast: null };
		const place = weather.place;
		const caches = cachesFor(ctx, version);
		const { temperatureUnit } = await ctx.family.settings();
		const key = `${roundCoordinate(place.latitude)},${roundCoordinate(place.longitude)},${temperatureUnit}`;
		const hit = caches.weather;
		// Parsed, not cast: a forecast cached before a field was added still gets its default.
		if (hit && hit.key === key && ctx.clock.now() - hit.at < WEATHER_TTL_MS)
			return { enabled: true, timing, forecast: ForecastSchema.parse(hit.value) };
		const forecast = await shared(caches, `weather:${key}`, () =>
			fetchForecast(ctx, place, temperatureUnit),
		);
		caches.weather = { at: ctx.clock.now(), key, value: forecast };
		return { enabled: true, timing, forecast };
	},
});

const Geocoding = z.object({
	results: z
		.array(
			z.object({
				name: z.string(),
				admin1: z.string().optional(),
				country: z.string().optional(),
				latitude: z.number(),
				longitude: z.number(),
			}),
		)
		.optional(),
});

export const searchPlaces = defineRoute({
	method: 'get',
	path: '/places',
	operationId: 'ambient.searchPlaces',
	summary: 'Find a place by name (Open-Meteo geocoding), for the weather setting',
	requires: ambientManage.id,
	query: z.object({ q: z.string().trim().min(2).max(80) }),
	response: z.array(PlaceResultSchema),
	async handle(ctx, { query }) {
		const { locale } = await ctx.family.settings();
		const params = new URLSearchParams({ name: query.q, count: '5', language: locale });
		try {
			const response = await ctx.http.get({
				url: `https://geocoding-api.open-meteo.com/v1/search?${params}`,
				headers: { accept: 'application/json' },
				maxBytes: 256 * 1024,
				timeoutMs: 15_000,
			});
			if (response.status !== 200) throw new ExternalHttpError('unreachable');
			const parsed = Geocoding.safeParse(JSON.parse(response.text));
			if (!parsed.success) throw new FamosError('unavailable', 'weather_bad_response');
			return (parsed.data.results ?? []).map(
				(r): PlaceResult => ({
					label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
					latitude: roundCoordinate(r.latitude),
					longitude: roundCoordinate(r.longitude),
				}),
			);
		} catch (error) {
			throw unavailable(
				error instanceof SyntaxError ? new ExternalHttpError('unreachable') : error,
			);
		}
	},
});
