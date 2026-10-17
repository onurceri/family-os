import { Temporal, WEEKDAYS, type Weekday } from '@famos/time';
import { FIELD_REASON, type FieldErrors, issueErrors, type RepeatPreset } from '@famos/ui/forms';
import { type Task, type TaskInput, TaskInputSchema, type TaskReplace } from '../contract/index.js';

/** Editable task form state; plain strings so inputs can bind to them. */
export interface TaskFormValue {
	title: string;
	/** Zero or one member id (chips). */
	assignee: string[];
	dueDate: string;
	dueTime: string;
	notes: string;
	repeat: RepeatPreset;
	byDay: string[];
	interval: number;
	until: string;
}

const weekdayOf = (date: string): Weekday =>
	WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1] as Weekday;

export function emptyTask(assignee: string | null, today: string): TaskFormValue {
	return {
		title: '',
		assignee: assignee ? [assignee] : [],
		dueDate: '',
		dueTime: '',
		notes: '',
		repeat: 'none',
		byDay: [weekdayOf(today)],
		interval: 1,
		until: '',
	};
}

export function taskFormFrom(source: TaskInput | Task, today: string): TaskFormValue {
	const recurrence = source.recurrence ?? null;
	const custom = 'rrule' in source && source.rrule !== null;
	return {
		title: source.title,
		assignee: source.assigneeId ? [source.assigneeId] : [],
		dueDate: source.dueDate ?? '',
		dueTime: source.dueTime ?? '',
		notes: source.notes ?? '',
		repeat: custom ? 'custom' : (recurrence?.freq ?? 'none'),
		byDay:
			recurrence?.freq === 'weekly' ? [...recurrence.byDay] : [weekdayOf(source.dueDate ?? today)],
		interval: recurrence?.interval ?? 1,
		until: recurrence?.until ?? '',
	};
}

export function taskInputFrom(v: TaskFormValue): TaskReplace {
	const text = (s: string) => s.trim() || null;
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
				: null;
	const dueDate = text(v.dueDate);
	return {
		title: v.title,
		assigneeId: v.assignee[0] ?? null,
		dueDate,
		dueTime: dueDate ? text(v.dueTime) : null,
		notes: text(v.notes),
		recurrence,
	};
}

/**
 * Why each field is refused (a translation key per field), the schema's checks included: what
 * the form shows under the fields when Save is refused. Empty when the task can be saved.
 */
export function validateTask(v: TaskFormValue): FieldErrors {
	const errors: FieldErrors = {};
	if (!v.title.trim()) errors.title = FIELD_REASON.title;
	if (v.repeat === 'custom') errors.recurrence = FIELD_REASON.repeat;
	if (v.repeat === 'weekly' && v.byDay.length === 0) errors.recurrence = FIELD_REASON.repeatDays;
	if (v.until && v.dueDate && v.until < v.dueDate) errors.until = FIELD_REASON.beforeStart;
	const result = TaskInputSchema.safeParse(taskInputFrom(v));
	if (!result.success)
		issueErrors(errors, result.error.issues, { dueDate: 'lists:error_repeat_date' });
	return errors;
}
