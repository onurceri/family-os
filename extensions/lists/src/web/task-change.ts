import { describeRecurrence, todayIn } from '@famos/time';
import { changed, type DraftBefore, type DraftField, type PresenterContext } from '@famos/ui/slots';
import type { TaskReplace } from '../contract/index.js';
import { dueLabel } from './format.js';
import type { ListsT } from './i18n.js';

/** What a `lists.changeTask` draft carries. */
export type ChangeTaskInput = {
	id: string;
	label?: string;
	title?: string;
	assigneeId?: string | null;
	dueDate?: string | null;
	dueTime?: string | null;
	notes?: string | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The rows of a proposed change to a task: only what changes, each as "old → new" when the task
 * as it is now is known (`before`), so the reviewer sees what it changes from.
 */
export function changeTaskFields(
	input: ChangeTaskInput,
	c: PresenterContext,
	before: DraftBefore = null,
): DraftField[] {
	const t = ((key: string, options?: Record<string, unknown>) =>
		c.t(`lists:${key}`, options)) as ListsT;
	const was = before ?? undefined;
	const fields: DraftField[] = [];
	if (input.title !== undefined && (was !== undefined || input.title !== input.label))
		fields.push({
			label: was === undefined ? t('draft_new_title') : t('field_title'),
			...changed(str(was?.title) ?? undefined, input.title),
			path: 'title',
		});
	if (input.assigneeId !== undefined) {
		const name = (id: string | null) =>
			c.members.find((m) => m.id === id)?.displayName ?? t('anyone');
		fields.push({
			label: t('who'),
			...changed(
				was && 'assigneeId' in was ? name(str(was.assigneeId)) : undefined,
				name(input.assigneeId),
			),
			path: 'assigneeId',
		});
	}
	if (input.dueDate !== undefined || input.dueTime !== undefined) {
		const today = todayIn(c.timeZone, Date.now());
		const due = (dueDate: string | null, dueTime: string | null) =>
			dueDate ? dueLabel({ dueDate, dueTime }, today, t, c.dateLocale, c.hourCycle) : t('no_due');
		const oldDate = str(was?.dueDate);
		const oldTime = str(was?.dueTime);
		const newDate = input.dueDate !== undefined ? input.dueDate : oldDate;
		const newTime = input.dueTime !== undefined ? input.dueTime : oldTime;
		fields.push({
			label: t('due'),
			...(was && 'dueDate' in was
				? changed(due(oldDate, oldTime), due(newDate, newDate ? newTime : null))
				: { value: due(input.dueDate ?? null, input.dueTime ?? null) }),
			paths: ['dueDate', 'dueTime'],
		});
	}
	if (input.notes !== undefined)
		fields.push({
			label: t('notes'),
			...changed(was && 'notes' in was ? (str(was.notes) ?? '—') : undefined, input.notes || '—'),
			path: 'notes',
		});
	return fields;
}

/** What a `lists.updateTask` draft carries: the whole task as the form saved it. */
export type UpdateTaskInput = { id: string; label?: string; task: TaskReplace };

/**
 * The rows of a saved edit of a task: the form sends every field, and `before` holds the ones
 * that differ from the task as it is now, so only those are listed, each as "old → new".
 */
export function updateTaskFields(
	input: UpdateTaskInput,
	c: PresenterContext,
	before: Record<string, unknown>,
): DraftField[] {
	const t = ((key: string, options?: Record<string, unknown>) =>
		c.t(`lists:${key}`, options)) as ListsT;
	const { task } = input;
	const values: Record<string, unknown> = {
		title: task.title,
		assigneeId: task.assigneeId ?? null,
		dueDate: task.dueDate ?? null,
		dueTime: task.dueDate ? (task.dueTime ?? null) : null,
		notes: task.notes ?? null,
	};
	const change = Object.fromEntries(
		Object.keys(before)
			.filter((k) => k in values)
			.map((k) => [k, values[k]]),
	);
	const fields = changeTaskFields({ id: input.id, ...change }, c, before);
	if ('recurrence' in before) {
		const repeat = (r: unknown) =>
			r && typeof r === 'object'
				? describeRecurrence(
						{ interval: 1, ...r } as Parameters<typeof describeRecurrence>[0],
						t,
						c.dateLocale,
						c.weekStart,
					)
				: t('repeat_none');
		fields.push({
			label: t('repeat'),
			...changed(repeat(before.recurrence), repeat(task.recurrence)),
			path: 'recurrence',
		});
	}
	return fields;
}
