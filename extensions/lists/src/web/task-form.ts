import { type RepeatChoices, type RepeatEdit, repeatChoices, repeatEditAsks } from '@famos/time';
import {
	FIELD_REASON,
	type FieldErrors,
	issueErrors,
	type RepeatPreset,
	recurrenceFromFields,
	repeatFieldsFrom,
} from '@famos/ui/forms';
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

export function emptyTask(assignee: string | null): TaskFormValue {
	return {
		title: '',
		assignee: assignee ? [assignee] : [],
		dueDate: '',
		dueTime: '',
		notes: '',
		repeat: 'none',
		// No date yet: the days stay empty and take the weekday of the date once it is set.
		byDay: [],
		interval: 1,
		until: '',
	};
}

export function taskFormFrom(source: TaskInput | Task): TaskFormValue {
	const recurrence = source.recurrence ?? null;
	const custom = 'rrule' in source && source.rrule !== null;
	return {
		title: source.title,
		assignee: source.assigneeId ? [source.assigneeId] : [],
		dueDate: source.dueDate ?? '',
		dueTime: source.dueTime ?? '',
		notes: source.notes ?? '',
		...repeatFieldsFrom(recurrence, source.dueDate, custom),
	};
}

const scheduleOf = (v: TaskFormValue): RepeatEdit => ({
	repeat: v.repeat,
	date: v.dueDate,
	byDay: v.byDay,
});

/** Whether saving the change of a saved repeating task must ask: only this one, or this one and the ones after. */
export const asksWhichOnes = (saved: TaskFormValue, form: TaskFormValue): boolean =>
	repeatEditAsks(scheduleOf(saved), scheduleOf(form));

/** What each answer does, `today` being where "only this one" looks for the next day of new days. */
export const taskChoices = (
	saved: TaskFormValue,
	form: TaskFormValue,
	today: string,
): RepeatChoices => repeatChoices(scheduleOf(saved), scheduleOf(form), today);

/** Only this one: the due date moves, the repeat stays as saved and the rest of the form is saved. */
export function onlyThisTask(
	saved: TaskFormValue,
	form: TaskFormValue,
	today: string,
): { task: TaskReplace; onlyThisDate: string } {
	const { repeat, byDay, interval, until } = saved;
	const onlyThisDate = taskChoices(saved, form, today).onlyDate;
	return {
		task: taskInputFrom({ ...form, repeat, byDay, interval, until, dueDate: onlyThisDate }),
		onlyThisDate,
	};
}

/** This one and the ones after: the form, a lone weekday following the date and the first due day on the days. */
export function fromThisTask(
	saved: TaskFormValue,
	form: TaskFormValue,
	today: string,
): TaskReplace {
	const { days, nextDate } = taskChoices(saved, form, today);
	return taskInputFrom({ ...form, byDay: days, dueDate: nextDate });
}

export function taskInputFrom(v: TaskFormValue): TaskReplace {
	const text = (s: string) => s.trim() || null;
	const recurrence = recurrenceFromFields(v);
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
	if (v.repeat === 'weekly' && v.byDay.length === 0) errors.recurrence = FIELD_REASON.repeatDays;
	if (v.until && v.dueDate && v.until < v.dueDate) errors.until = FIELD_REASON.beforeStart;
	const result = TaskInputSchema.safeParse(taskInputFrom(v));
	if (!result.success)
		issueErrors(errors, result.error.issues, { dueDate: 'lists:error_repeat_date' });
	return errors;
}
