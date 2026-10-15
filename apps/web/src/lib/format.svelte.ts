import { dateLocale } from '@famos/time';
import { family } from './family.svelte.js';
import { getLocale } from './i18n.svelte.js';

/**
 * Dates and times: day and month names in the reader's language, the order of the family's
 * region format and its hour cycle. Read inside `$derived` or the template so it follows changes.
 */
export function familyDateLocale(): string {
	return dateLocale(getLocale(), family.formatLocale, family.hourCycle);
}

/**
 * Dates and times in the reader's words and the family's region formats, never the UI language
 * alone. Read these inside `$derived` or the template so they update when the settings change.
 */
export function dateTimeFormat(options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
	const clock = options.hour !== undefined || options.timeStyle !== undefined;
	return new Intl.DateTimeFormat(familyDateLocale(), {
		...(clock && options.hour12 === undefined && { hourCycle: family.hourCycle }),
		...options,
	});
}

/** Numbers follow the family's region format; they hold no words. */
export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
	return new Intl.NumberFormat(family.formatLocale, options);
}
