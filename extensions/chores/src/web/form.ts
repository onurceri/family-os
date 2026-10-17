import { compareDates, formatDate, Temporal, WEEKDAYS, type Weekday } from '@famos/time';
import { FIELD_REASON, type FieldErrors, issueErrors, type RepeatPreset } from '@famos/ui/forms';
import {
	type Chore,
	ChoreDetailsSchema,
	type CreateChoreInput,
	type Rotation,
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

const weekdayOf = (date: string): Weekday =>
	WEEKDAYS[Temporal.PlainDate.from(date).dayOfWeek - 1] as Weekday;

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
	const rec = chore.recurrence;
	return {
		title: chore.title,
		notes: chore.notes ?? '',
		startDate: chore.startDate,
		repeat: rec?.freq ?? 'none',
		byDay: rec?.freq === 'weekly' ? [...rec.byDay] : [weekdayOf(chore.startDate)],
		interval: rec?.interval ?? 1,
		until: rec?.until ?? '',
		assigneeIds: [...chore.assigneeIds],
		rotation: chore.rotation,
	};
}

export function toDetails(v: ChoreFormValue): Omit<CreateChoreInput, 'assigneeIds'> {
	const until = v.until.trim() || null;
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
	return {
		title: v.title,
		notes: v.notes.trim() || null,
		recurrence,
		startDate: v.startDate,
		rotation: v.assigneeIds.length > 1 ? v.rotation : 'fixed',
	};
}

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
	const days = Math.round((Date.parse(nextDue) - Date.parse(today)) / 86_400_000);
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
	const days = dueDate ? Math.round((Date.parse(dueDate) - Date.parse(today)) / 86_400_000) : 0;
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
