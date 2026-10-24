import { type Recurrence, type Weekday, weekdayOf } from '@famos/time';
import type { RepeatPreset } from './forms.js';

/** The repeat fields of a form as the inputs hold them: plain strings and numbers to bind to. */
export interface RepeatFormFields {
	repeat: RepeatPreset;
	byDay: string[];
	interval: number;
	until: string;
}

/**
 * The repeat fields for a saved rule. `anchor` is the date the rule starts on (a lone weekday
 * follows it; none yet leaves the days empty); `custom` marks a rule outside the presets.
 */
export function repeatFieldsFrom(
	recurrence: Recurrence | null | undefined,
	anchor: string | null | undefined,
	custom = false,
): RepeatFormFields {
	return {
		repeat: custom ? 'custom' : (recurrence?.freq ?? 'none'),
		byDay:
			recurrence?.freq === 'weekly' ? [...recurrence.byDay] : anchor ? [weekdayOf(anchor)] : [],
		interval: recurrence?.interval ?? 1,
		until: recurrence?.until ?? '',
	};
}

/** The rule the repeat fields describe; null for none or a custom rule the form cannot build. */
export function recurrenceFromFields(v: RepeatFormFields): Recurrence | null {
	const until = v.until.trim();
	if (v.repeat === 'daily' || v.repeat === 'monthly')
		return { freq: v.repeat, interval: v.interval, ...(until && { until }) };
	if (v.repeat === 'weekly')
		return {
			freq: 'weekly',
			interval: v.interval,
			byDay: v.byDay as Weekday[],
			...(until && { until }),
		};
	return null;
}
