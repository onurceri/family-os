import type { DbExecutor, FamilyMember, FamilyReader, FamilySettings } from '@famos/sdk';
import {
	canonicalLocale,
	defaultHourCycle,
	defaultTemperatureUnit,
	defaultWeekStart,
	formatLocaleForLanguage,
	isFormatLocale,
	TimeZoneSchema,
	WeekStartSchema,
} from '@famos/time';
import { z } from 'zod';
import type { CoreTables } from './tables.ts';

/**
 * Household-wide settings (time zone, default language), stored in `core_settings` under
 * `family`. Read through the caller's executor: inside a unit of work, pass the transaction,
 * never the root connection (it would wait on itself).
 */
/** A language code: a well-formed BCP 47 tag, in its canonical form (whether a pack exists is checked by the registry). */
export const LanguageCodeSchema = z
	.string()
	.max(35)
	.refine(isFormatLocale, 'Not a valid BCP 47 language code')
	.transform((tag) => canonicalLocale(tag));

/** The family's name as people say it ("The Novaks"); optional, shown where the family is greeted. */
export const FamilyNameSchema = z.string().trim().min(1).max(60);

export const FamilySettingsSchema = z.object({
	name: FamilyNameSchema.optional(),
	timeZone: TimeZoneSchema,
	locale: LanguageCodeSchema,
	formatLocale: z
		.string()
		.max(35)
		.refine(isFormatLocale, 'Not a valid BCP 47 language tag')
		.transform((tag) => canonicalLocale(tag)),
	weekStart: WeekStartSchema,
	hourCycle: z.enum(['h12', 'h23']),
	temperatureUnit: z.enum(['celsius', 'fahrenheit']),
});

/** The region formats a region implies: what `Intl` says about the format locale. */
export function regionFormats(
	formatLocale: string,
): Pick<FamilySettings, 'formatLocale' | 'weekStart' | 'hourCycle' | 'temperatureUnit'> {
	const tag = canonicalLocale(formatLocale);
	return {
		formatLocale: tag,
		weekStart: defaultWeekStart(tag),
		hourCycle: defaultHourCycle(tag),
		temperatureUnit: defaultTemperatureUnit(tag),
	};
}

/**
 * Settings before setup has run: English, UTC, weeks from Monday, Celsius. Setup stores the
 * family's own choices, always complete.
 */
export const DEFAULT_FAMILY_SETTINGS: FamilySettings = {
	timeZone: 'UTC',
	locale: 'en',
	formatLocale: formatLocaleForLanguage('en'),
	weekStart: 1,
	hourCycle: defaultHourCycle(formatLocaleForLanguage('en')),
	temperatureUnit: 'celsius',
};
const KEY = 'family';

export async function readFamilySettings(db: DbExecutor): Promise<FamilySettings> {
	const row = await db
		.withTables<CoreTables>()
		.selectFrom('core_settings')
		.select('value')
		.where('key', '=', KEY)
		.executeTakeFirst();
	if (!row) return DEFAULT_FAMILY_SETTINGS;
	const stored = JSON.parse(row.value) as Partial<FamilySettings>;
	const parsed = FamilySettingsSchema.safeParse({ ...DEFAULT_FAMILY_SETTINGS, ...stored });
	return parsed.success ? parsed.data : DEFAULT_FAMILY_SETTINGS;
}

export async function writeFamilySettings(
	db: DbExecutor,
	settings: FamilySettings,
	now: number,
): Promise<void> {
	const value = JSON.stringify(FamilySettingsSchema.parse(settings));
	await db
		.withTables<CoreTables>()
		.insertInto('core_settings')
		.values({ key: KEY, value, updated_at: now })
		.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
		.execute();
}

export async function readActiveMembers(db: DbExecutor): Promise<FamilyMember[]> {
	const rows = await db
		.withTables<CoreTables>()
		.selectFrom('core_members')
		.select(['id', 'display_name', 'role_id', 'color', 'about', 'locale'])
		.where('archived_at', 'is', null)
		.orderBy('created_at')
		.execute();
	return rows.map((r) => ({
		id: r.id,
		displayName: r.display_name,
		roleId: r.role_id,
		color: r.color,
		about: r.about,
		locale: r.locale,
	}));
}

export const familyReader = (db: DbExecutor): FamilyReader => ({
	settings: () => readFamilySettings(db),
	members: () => readActiveMembers(db),
});
