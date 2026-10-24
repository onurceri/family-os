import { idSchema, wholeRecord } from '@famos/sdk';
import { z } from 'zod';

/**
 * Ambient contract: what the display-content settings and the photo and weather routes exchange.
 */

export const TimingSchema = z.object({
	/** Minutes without interaction before a display switches to ambient mode. */
	idleMinutes: z.number().int().min(1).max(240).default(5),
	/** Seconds each photo stays on screen. */
	slideSeconds: z.number().int().min(5).max(600).default(30),
});
export type Timing = z.infer<typeof TimingSchema>;
export const DEFAULT_TIMING: Timing = { idleMinutes: 5, slideSeconds: 30 };

/** Coordinates are rounded to two decimals (about a kilometre) before they are stored or sent. */
export const roundCoordinate = (value: number) => Math.round(value * 100) / 100;

export const PlaceSchema = z.object({
	name: z.string().trim().min(1).max(120),
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
});
export type Place = z.infer<typeof PlaceSchema>;

export const WeatherSettingsSchema = z.object({
	enabled: z.boolean(),
	place: PlaceSchema.nullable(),
});
export type WeatherSettings = z.infer<typeof WeatherSettingsSchema>;

/** The whole settings row (JSON). */
export const StoredSettingsSchema = z.object({
	weather: WeatherSettingsSchema.default({ enabled: false, place: null }),
	timing: TimingSchema.default(DEFAULT_TIMING),
});
export type StoredSettings = z.infer<typeof StoredSettingsSchema>;

/** Settings as the API shows them. */
export const AmbientSettingsSchema = z.object({
	weather: WeatherSettingsSchema,
	timing: TimingSchema,
});
export type AmbientSettings = z.infer<typeof AmbientSettingsSchema>;

export const UpdateWeatherInputSchema = WeatherSettingsSchema;
/** Both timings, as the settings page saves them: one left out is refused, never reset. */
export const UpdateTimingInputSchema = wholeRecord(TimingSchema);

export const PhotoIdSchema = idSchema('amb_photo');

/** After the browser resized it (a 1920 px JPEG is a few hundred KB). */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Larger than this on either side is not a screen photo. */
export const PHOTO_MAX_SIDE = 8192;

/** What the upload route hands the `ambient.addPhoto` action once the file is stored. */
export const StoredPhotoSchema = z.object({
	/** Only keys the upload route makes: the action is also reachable at /actions, and must not point at other files. */
	key: z.string().regex(/^ambient\/photos\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/),
	type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
	width: z.number().int().min(1).max(PHOTO_MAX_SIDE),
	height: z.number().int().min(1).max(PHOTO_MAX_SIDE),
	size: z.number().int().min(1).max(PHOTO_MAX_BYTES),
});

/** A photo in the settings library. */
export const LibraryPhotoSchema = z.object({
	id: z.string(),
	contentType: z.string(),
	width: z.number().int(),
	height: z.number().int(),
	size: z.number().int(),
	uploadedBy: z.string().nullable(),
	createdAt: z.number(),
});
export type LibraryPhoto = z.infer<typeof LibraryPhotoSchema>;

/**
 * The photo of the day on Today and on displays: one photo per family day, the same all day.
 * `month` is when it was added (`YYYY-MM`, family time zone), for a label such as "From the
 * photos · March 2026" in the family's format locale. `photo` is null when there are no photos.
 */
export const PhotoOfTheDaySchema = z.object({
	photo: z
		.object({
			/** Fetch it at `/api/v1/ambient/photos/{photoId}`. */
			id: z.string(),
			month: z.string().regex(/^\d{4}-\d{2}$/),
		})
		.nullable(),
});
export type PhotoOfTheDay = z.infer<typeof PhotoOfTheDaySchema>;

export const PhotoListSchema = z.object({
	/** Photo ids, shuffled; fetch each at `/api/v1/ambient/photos/{photoId}`. */
	ids: z.array(z.string()),
	timing: TimingSchema,
});
export type PhotoList = z.infer<typeof PhotoListSchema>;

/** One hour of the forecast; `at` is the instant the hour starts (epoch ms). */
export const ForecastHourSchema = z.object({
	at: z.number(),
	temperature: z.number(),
	/** WMO weather code. */
	code: z.number().int(),
	precipitationProbability: z.number().nullable(),
});
export type ForecastHour = z.infer<typeof ForecastHourSchema>;

export const ForecastSchema = z.object({
	temperature: z.number(),
	/** The unit of every temperature in this forecast (the family's setting). */
	unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
	/** WMO weather code. */
	weatherCode: z.number().int(),
	/** Whether the sun is up at the place right now (Open-Meteo `is_day`). */
	isDay: z.boolean().default(true),
	min: z.number(),
	max: z.number(),
	precipitationProbability: z.number().nullable(),
	place: z.string(),
	fetchedAt: z.number(),
	/** Today and tomorrow hour by hour; empty in a forecast cached before hours were fetched. */
	hourly: z.array(ForecastHourSchema).default([]),
});
export type Forecast = z.infer<typeof ForecastSchema>;

/** `enabled: false` (or no place yet) is a normal answer, not an error: the widget stays away. */
export const WeatherSchema = z.object({
	enabled: z.boolean(),
	timing: TimingSchema,
	forecast: ForecastSchema.nullable(),
});
export type Weather = z.infer<typeof WeatherSchema>;

export const PlaceResultSchema = z.object({
	label: z.string(),
	latitude: z.number(),
	longitude: z.number(),
});
export type PlaceResult = z.infer<typeof PlaceResultSchema>;

export const settingsChangedPayload = z.object({});
