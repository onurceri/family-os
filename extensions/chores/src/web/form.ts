import {
	compareDates,
	daysBetween,
	formatDate,
	type RepeatChoices,
	type RepeatEdit,
	repeatChoices,
	repeatEditAsks,
	weekdayOf,
} from '@famos/time';
import {
	FIELD_REASON,
	type FieldErrors,
	issueErrors,
	type RepeatPreset,
	recurrenceFromFields,
	repeatFieldsFrom,
} from '@famos/ui/forms';
import {
	type Chore,
	ChoreDetailsSchema,
	type Rotation,
	type UpdateChoreInput,
} from '../contract/index.js';
import type { ChoresT } from './i18n.js';

/** The chore form as the inputs hold it. */
export interface ChoreFormValue {
	title: string;
	notes: string;
	startDate: string;
	repeat: RepeatPreset;
	byDay: string[];
	interval: number;
	until: string;
	/** The people in turn order. */
	assigneeIds: string[];
	rotation: Rotation;
}

export const emptyChore = (today: string): ChoreFormValue => ({
	title: '',
	notes: '',
	startDate: today,
	repeat: 'weekly',
	byDay: [weekdayOf(today)],
	interval: 1,
	until: '',
	assigneeIds: [],
	rotation: 'round_robin',
});

export function fromChore(chore: Chore): ChoreFormValue {
	return {
		title: chore.title,
		notes: chore.notes ?? '',
		startDate: chore.startDate,
		...repeatFieldsFrom(chore.recurrence, chore.startDate),
		assigneeIds: [...chore.assigneeIds],
		rotation: chore.rotation,
	};
}

export function toDetails(v: ChoreFormValue): UpdateChoreInput['chore'] {
	const recurrence = recurrenceFromFields(v);
	return {
		title: v.title,
		notes: v.notes.trim() || null,
		recurrence,
		startDate: v.startDate,
		rotation: v.assigneeIds.length > 1 ? v.rotation : 'fixed',
	};
}

const scheduleOf = (v: ChoreFormValue): RepeatEdit => ({
	repeat: v.repeat,
	date: v.startDate,
	byDay: v.byDay,
});

/** Whether saving the change of a saved chore must ask: only this turn, or this one and the ones after. */
export const asksWhichTurns = (saved: ChoreFormValue, form: ChoreFormValue): boolean =>
	repeatEditAsks(scheduleOf(saved), scheduleOf(form));

/** What each answer does to a saved chore, `today` being where "only this turn" looks for the next day of new days. */
export const turnChoices = (
	saved: ChoreFormValue,
	form: ChoreFormValue,
	today: string,
): RepeatChoices => repeatChoices(scheduleOf(saved), scheduleOf(form), today);

/** Only this turn moves: the saved schedule stays, the rest of the form is saved. */
export function onlyThisTurn(
	saved: ChoreFormValue,
	form: ChoreFormValue,
	today: string,
): Omit<UpdateChoreInput, 'id'> {
	const { startDate, repeat, byDay, interval, until } = saved;
	return {
		chore: toDetails({ ...form, startDate, repeat, byDay, interval, until }),
		onlyThisTurnOn: turnChoices(saved, form, today).onlyDate,
	};
}

/** This turn and the ones after: the form as it is, a lone weekday following the new date. */
export const fromThisTurnOn = (
	saved: ChoreFormValue,
	form: ChoreFormValue,
	today: string,
): UpdateChoreInput['chore'] => toDetails({ ...form, byDay: turnChoices(saved, form, today).days });

/** Why each field is refused (a translation key per field), the schema's checks included. */
export function validate(v: ChoreFormValue): FieldErrors {
	const errors: FieldErrors = {};
	if (!v.title.trim()) errors.title = FIELD_REASON.title;
	if (!v.startDate) errors.startDate = FIELD_REASON.date;
	if (v.repeat === 'custom') errors.recurrence = FIELD_REASON.repeat;
	if (v.repeat === 'weekly' && v.byDay.length === 0) errors.recurrence = FIELD_REASON.repeatDays;
	if (v.until && v.startDate && v.until < v.startDate) errors.until = FIELD_REASON.beforeStart;
	const result = ChoreDetailsSchema.safeParse(toDetails(v));
	if (!result.success) issueErrors(errors, result.error.issues);
	return errors;
}

/** "Today", "Tomorrow", "3 days overdue", "Fri 9 Oct". */
export function dueLabel(
	nextDue: string | null,
	today: string,
	t: ChoresT,
	locale: string,
): string {
	if (!nextDue) return t('done');
	const days = daysBetween(today, nextDue);
	if (days < -1) return t('overdue_days', { count: -days });
	if (days === -1) return t('due_yesterday');
	if (days === 0) return t('due_today');
	if (days === 1) return t('due_tomorrow');
	return formatDate(
		nextDue,
		locale,
		days < 7 ? { weekday: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' },
	);
}

/**
 * The toast after a tick. A chore may be done ahead of its day (a weekly one a day early); then
 * the toast names the day it counted for, so a tick on the wrong row is seen and can be undone.
 */
export function doneToast(
	title: string,
	dueDate: string | null,
	today: string,
	t: ChoresT,
	locale: string,
): string {
	const days = dueDate ? daysBetween(today, dueDate) : 0;
	if (!dueDate || days <= 0) return t('done_toast', { title });
	if (days === 1) return t('done_toast_tomorrow', { title });
	return t('done_toast_ahead', { title, day: dueLabel(dueDate, today, t, locale) });
}

export type Group = 'overdue' | 'today' | 'upcoming' | 'done';

export function groupOf(chore: Pick<Chore, 'nextDue'>, today: string): Group {
	if (!chore.nextDue) return 'done';
	const c = compareDates(chore.nextDue, today);
	return c < 0 ? 'overdue' : c === 0 ? 'today' : 'upcoming';
}
