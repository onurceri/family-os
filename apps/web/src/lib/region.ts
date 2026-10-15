import { canonicalLocale, isFormatLocale } from '@famos/time';

/** A time zone's current offset ("GMT+3"), or nothing when the zone is unknown. */
export function offsetOf(zone: string, at: Date = new Date()): string {
	try {
		return (
			new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
				.formatToParts(at)
				.find((p) => p.type === 'timeZoneName')?.value ?? ''
		);
	} catch {
		return '';
	}
}

/** Every time zone the runtime knows, with its current offset. UTC is always offered. */
export function timeZoneOptions(at: Date = new Date()): { value: string; label: string }[] {
	const zones = Intl.supportedValuesOf('timeZone');
	return (zones.includes('UTC') ? zones : ['UTC', ...zones]).map((zone) => ({
		value: zone,
		label: `${zone.replaceAll('_', ' ')} (${offsetOf(zone, at)})`,
	}));
}

/** "sl-SI" → "Slovenian (Slovenia)" in the given UI language: a name, not a format. */
export function localeName(code: string, uiLocale: string): string {
	try {
		return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? '';
	} catch {
		return '';
	}
}

const validTags = (tags: readonly string[]) =>
	tags.filter(isFormatLocale).map((tag) => canonicalLocale(tag));

/**
 * The region format a browser's preferred languages describe. A region format is about where the
 * family lives, not which language the app speaks, so it is the browser's own tag: the first one
 * with a region (`sl-SI`), else the first bare language (`sl`), else `en-US`. It is never a mix of
 * the app's language and the browser's region.
 */
export function regionFormatLocale(browserTags: readonly string[]): string {
	const tags = validTags(browserTags);
	return tags.find((tag) => new Intl.Locale(tag).region) ?? tags[0] ?? 'en-US';
}

/**
 * Region formats to offer when nothing is set yet: the one in use, then the browser's own tags in
 * its order of preference. Any other valid tag can still be typed.
 */
export function startingFormatLocales(current: string, browserTags: readonly string[]): string[] {
	return [...new Set(validTags([current, ...browserTags]))];
}
