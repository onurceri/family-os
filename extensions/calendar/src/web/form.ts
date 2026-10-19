import {
	addDays,
	type RepeatChoices,
	type RepeatEdit,
	repeatChoices,
	repeatEditAsks,
	Temporal,
	type Weekday,
	weekdayOf,
} from '@famos/time';
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

const daysBetween = (from: string, to: string) =>
	Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** The form with its first day moved to `date`; a multi-day event keeps its length. */
export function onDate(v: EventFormValue, date: string): EventFormValue {
	if (!v.date || v.date === date) return { ...v, date };
	return {
		...v,
		date,
		endDate: v.endDate ? addDays(v.endDate, daysBetween(v.date, date)) : v.endDate,
	};
}

const scheduleOf = (v: EventFormValue): RepeatEdit => ({
	repeat: v.repeat,
	date: v.date,
	byDay: v.byDay,
});

/**
 * A repeating event opened from one of its dates: the form holds that date, so changing the date
 * moves this one and the ones after it, not the series' first day.
 */
export const atOccurrence = (v: EventFormValue, day: string): EventFormValue =>
	v.repeat === 'none' ? v : onDate(v, day);

/** Whether saving the change of a saved repeating event must ask: only this one, or this one and the ones after. */
export const asksWhichDates = (saved: EventFormValue, form: EventFormValue): boolean =>
	repeatEditAsks(scheduleOf(saved), scheduleOf(form));

/** What each answer does, `from` being where "only this one" looks for the next day of new days. */
export const dateChoices = (
	saved: EventFormValue,
	form: EventFormValue,
	from: string,
): RepeatChoices => repeatChoices(scheduleOf(saved), scheduleOf(form), from);

/** Only this date: it becomes an event of its own on its new day. */
export const onlyThisDateForm = (
	saved: EventFormValue,
	form: EventFormValue,
	from: string,
): EventFormValue => ({
	...onDate(form, dateChoices(saved, form, from).onlyDate),
	repeat: 'none',
});

/** This date and the ones after: the new series, starting on its first matching day. */
export function fromThisDateForm(
	saved: EventFormValue,
	form: EventFormValue,
	from: string,
): EventFormValue {
	const { days, nextDate } = dateChoices(saved, form, from);
	return { ...onDate(form, nextDate), byDay: days };
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
