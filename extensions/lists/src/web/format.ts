import {
	addDays,
	compareDates,
	formatClock,
	formatDate,
	type HourCycle,
	weekOf,
} from '@famos/time';
import type { Task } from '../contract/index.js';
import type { ListsT } from './i18n.js';

export type Urgency = 'overdue' | 'today' | 'soon' | 'nextWeek' | 'later' | 'none';

/**
 * When a task is due, as the Tasks page groups it, by the family's weeks (`weekStart`, ISO
 * 1 = Monday … 7 = Sunday): `soon` ("This week") ends on the last day of this week, `nextWeek`
 * is the whole week after it, and only what comes after that is `later`. On the last day of a
 * week, tomorrow is next week.
 */
export function urgency(task: Pick<Task, 'dueDate'>, today: string, weekStart: number): Urgency {
	if (!task.dueDate) return 'none';
	const c = compareDates(task.dueDate, today);
	if (c < 0) return 'overdue';
	if (c === 0) return 'today';
	const lastOfWeek = weekOf(today, weekStart)[6] ?? today;
	if (compareDates(task.dueDate, lastOfWeek) <= 0) return 'soon';
	const lastOfNext = weekOf(addDays(lastOfWeek, 1), weekStart)[6] ?? lastOfWeek;
	return compareDates(task.dueDate, lastOfNext) <= 0 ? 'nextWeek' : 'later';
}

/** The groups of the Tasks page, in order: late first, then by when, those without a date last. */
export const TASK_GROUPS = ['overdue', 'today', 'soon', 'nextWeek', 'later', 'none'] as const;

/**
 * The open tasks by when they are due, for everyone or for one person (`mine`). Groups with
 * nothing are left out; within a group the earliest comes first (by time, then as listed).
 */
export function groupTasks<T extends Pick<Task, 'dueDate' | 'dueTime' | 'doneAt' | 'assigneeId'>>(
	tasks: readonly T[],
	today: string,
	weekStart: number,
	mine: string | null = null,
): { key: Urgency; tasks: T[] }[] {
	const open = tasks.filter((task) => task.doneAt === null && (!mine || task.assigneeId === mine));
	const when = (task: T) => `${task.dueDate ?? ''} ${task.dueTime ?? '99:99'}`;
	return TASK_GROUPS.map((key) => ({
		key,
		tasks: open
			.filter((task) => urgency(task, today, weekStart) === key)
			.toSorted((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0)),
	})).filter((group) => group.tasks.length > 0);
}

/** "Today", "Tomorrow", "3 days overdue", "Fri 9 Oct" (+ time). */
export function dueLabel(
	task: Pick<Task, 'dueDate' | 'dueTime'>,
	today: string,
	t: ListsT,
	locale: string,
	hourCycle?: HourCycle,
): string {
	const { dueDate, dueTime } = task;
	if (!dueDate) return t('no_due');
	const days = Math.round((Date.parse(dueDate) - Date.parse(today)) / 86_400_000);
	const day =
		days < -1
			? t('overdue_days', { count: -days })
			: days === -1
				? t('due_yesterday')
				: days === 0
					? t('due_today')
					: days === 1
						? t('due_tomorrow')
						: formatDate(
								dueDate,
								locale,
								days < 7
									? { weekday: 'long' }
									: { weekday: 'short', day: 'numeric', month: 'short' },
							);
	return dueTime ? `${day} · ${formatClock(dueTime, locale, hourCycle)}` : day;
}

/** Whether ticking an item should say where it went: it left the list for a folded-away cart. */
export const movedToHiddenCart = (
	ticked: boolean,
	outcome: 'applied' | 'drafted' | 'queued',
	cartOpen: boolean,
): boolean => ticked && outcome === 'applied' && !cartOpen;
