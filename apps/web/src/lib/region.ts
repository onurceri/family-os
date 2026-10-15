import { canonicalLocale, isFormatLocale, setupFormatLocale } from '@famos/time';

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

/**
 * Region formats to offer when nothing is set yet: the one in use, the browser's, and every
 * installed language with the browser's region. Any other valid tag can still be typed.
 */
export function startingFormatLocales(
	current: string,
	browser: string,
	languages: readonly string[],
): string[] {
	const tags = [current, browser, ...languages.map((code) => setupFormatLocale(code, browser))];
	return [...new Set(tags.filter(isFormatLocale).map((tag) => canonicalLocale(tag)))];
}
