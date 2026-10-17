import { Temporal, WEEKDAYS, type Weekday } from '@famos/time';
import { FIELD_REASON, type FieldErrors, issueErrors, type RepeatPreset } from '@famos/ui/forms';
import {
	ALL_DAY_REMINDERS,
	defaultReminder,
	type EventDetail,
	type EventInput,
	EventInputSchema,
	type EventReplace,
	TIMED_REMINDERS,
} from '../contract/index.js';

/** Editable form state: every field is a plain string/boolean so inputs can bind to it. */
export interface EventFormValue {
	title: string;
	allDay: boolean;
	date: string;
	endDate: string;
	startTime: string;
	endTime: string;
	memberIds: string[];
	location: string;
	notes: string;
	repeat: RepeatPreset;
	/** RRULE weekday codes (`MO` … `SU`). */
	byDay: string[];
	interval: number;
	until: string;
	/** Minutes before the start as a string, or `none`. */
	reminder: string;
	tags: string[];
}

/** The reminder presets offered for timed or all-day events. */
export const reminderOptions = (allDay: boolean): readonly number[] =>
	allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;

export type ReminderKey =
	| `reminder_t_${(typeof TIMED_REMINDERS)[number]}`
	| `reminder_all_day_${(typeof ALL_DAY_REMINDERS)[number]}`;

/** The catalog key naming a preset. */
export const reminderKey = (allDay: boolean, minutes: number) =>
	(allDay ? `reminder_all_day_${minutes}` : `reminder_t_${minutes}`) as ReminderKey;

/** Switching between timed and all-day keeps the reminder only if it exists in the other set. */
export function reminderFor(allDay: boolean, current: string): string {
	return current === 'none' || reminderOptions(allDay).includes(Number(current))
		? current
		: String(defaultReminder(allDay));
}

const weekdayOf = (date: string): Weekday =>
	WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1] as Weekday;

/**
 * The weekly repeat days after the date moved from `previousDate` to `nextDate`. A repeat that
 * only held the old date's weekday follows the date. Days the person chose themselves are never
 * dropped: the new date's weekday is added to them, so a weekly event always includes the day it
 * starts on.
 */
export function weekdaysAfterDateChange(
	byDay: readonly string[],
	previousDate: string,
	nextDate: string,
): string[] {
	if (!DATE.test(nextDate)) return [...byDay];
	const next = weekdayOf(nextDate);
	if (byDay.includes(next)) return [...byDay];
	const followsDate =
		byDay.length === 0 ||
		(byDay.length === 1 && DATE.test(previousDate) && byDay[0] === weekdayOf(previousDate));
	return followsDate ? [next] : [...byDay, next];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A sensible new event on `date`: the next full hour today, otherwise 09:00. */
export function emptyForm(date: string, now: Temporal.ZonedDateTime): EventFormValue {
	const isToday = now.toPlainDate().toString() === date;
	const hour = isToday ? Math.min(now.hour + 1, 23) : 9;
	const pad = (n: number) => String(n).padStart(2, '0');
	return {
		title: '',
		allDay: false,
		date,
		endDate: '',
		startTime: `${pad(hour)}:00`,
		endTime: hour < 23 ? `${pad(hour + 1)}:00` : '',
		memberIds: [],
		location: '',
		notes: '',
		repeat: 'none',
		byDay: [weekdayOf(date)],
		interval: 1,
		until: '',
		reminder: String(defaultReminder(false)),
		tags: [],
	};
}

export function formFrom(source: EventInput | EventDetail): EventFormValue {
	const recurrence = source.recurrence ?? null;
	const custom = 'rrule' in source && source.rrule !== null;
	return {
		title: source.title,
		allDay: source.allDay ?? false,
		date: source.date,
		endDate: source.endDate ?? '',
		startTime: source.startTime ?? '',
		endTime: source.endTime ?? '',
		memberIds: [...(source.memberIds ?? [])],
		location: source.location ?? '',
		notes: source.notes ?? '',
		repeat: custom ? 'custom' : (recurrence?.freq ?? 'none'),
		byDay: recurrence?.freq === 'weekly' ? [...recurrence.byDay] : [weekdayOf(source.date)],
		interval: recurrence?.interval ?? 1,
		until: recurrence?.until ?? '',
		reminder:
			source.reminder === null
				? 'none'
				: String(source.reminder ?? defaultReminder(source.allDay ?? false)),
		tags: [...(source.tags ?? [])],
	};
}

/** Form → action input. Empty strings become absent fields. */
export function inputFrom(v: EventFormValue): EventInput {
	const text = (s: string) => (s.trim() ? s.trim() : undefined);
	const until = text(v.until);
	const recurrence =
		v.repeat === 'daily' || v.repeat === 'monthly'
			? { freq: v.repeat, interval: v.interval, ...(until && { until }) }
			: v.repeat === 'weekly'
				? {
						freq: 'weekly' as const,
						interval: v.interval,
						byDay: v.byDay as Weekday[],
						...(until && { until }),
					}
				: undefined;
	const input: EventInput = {
		title: v.title,
		allDay: v.allDay,
		date: v.date,
		memberIds: v.memberIds,
		reminder: v.reminder === 'none' ? null : Number(v.reminder),
	};
	if (v.allDay) {
		const endDate = text(v.endDate);
		if (endDate && endDate !== v.date) input.endDate = endDate;
	} else {
		input.startTime = v.startTime;
		const endTime = text(v.endTime);
		if (endTime) input.endTime = endTime;
	}
	const location = text(v.location);
	const notes = text(v.notes);
	if (location) input.location = location;
	if (notes) input.notes = notes;
	if (recurrence) input.recurrence = recurrence;
	if (v.tags.length) input.tags = v.tags;
	return input;
}

/** Form → the whole event for a replace: every field, null for one left empty. */
export function replaceFrom(v: EventFormValue): EventReplace {
	const input = inputFrom(v);
	return {
		title: input.title,
		allDay: v.allDay,
		date: input.date,
		endDate: input.endDate ?? null,
		startTime: input.startTime ?? null,
		endTime: input.endTime ?? null,
		memberIds: v.memberIds,
		location: input.location ?? null,
		notes: input.notes ?? null,
		recurrence: input.recurrence ?? null,
		reminder: input.reminder ?? null,
		tags: input.tags ?? [],
	};
}

/**
 * Why each field is refused (a translation key per field), the schema's checks included: what
 * the form shows under the fields when Save is refused. Empty when the event can be saved.
 */
export function validate(v: EventFormValue): FieldErrors {
	const errors: FieldErrors = {};
	if (!v.title.trim()) errors.title = FIELD_REASON.title;
	if (!v.date) errors.date = FIELD_REASON.date;
	if (!v.allDay && !v.startTime) errors.startTime = FIELD_REASON.time;
	if (v.repeat === 'custom') errors.recurrence = FIELD_REASON.repeat;
	if (v.repeat === 'weekly' && v.byDay.length === 0) errors.recurrence = FIELD_REASON.repeatDays;
	if (v.until && v.until < v.date) errors.until = FIELD_REASON.beforeStart;
	const result = EventInputSchema.safeParse(inputFrom(v));
	if (!result.success)
		issueErrors(errors, result.error.issues, {
			endDate: FIELD_REASON.beforeStart,
			endTime: 'calendar:error_end_same',
		});
	return errors;
}

/** Keeps the end time after the start when the start moves (same duration). */
export function shiftEnd(previousStart: string, nextStart: string, end: string): string {
	if (!previousStart || !nextStart || !end) return end;
	const base = Temporal.PlainDate.from('2000-01-01');
	const minutes = (t: string) => base.toPlainDateTime(Temporal.PlainTime.from(t));
	const duration = minutes(previousStart).until(minutes(end));
	if (duration.sign <= 0) return end;
	const shifted = minutes(nextStart).add(duration);
	return shifted.toPlainDate().equals(base)
		? shifted.toPlainTime().toString().slice(0, 5)
		: '23:59';
}
