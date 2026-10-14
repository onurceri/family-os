import { todayIn } from '@famos/time';
import {
	changedValue,
	type DraftBefore,
	type DraftField,
	type PresenterContext,
} from '@famos/ui/slots';
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
			value: changedValue(str(was?.title) ?? undefined, input.title),
			path: 'title',
		});
	if (input.assigneeId !== undefined) {
		const name = (id: string | null) =>
			c.members.find((m) => m.id === id)?.displayName ?? t('anyone');
		fields.push({
			label: t('who'),
			value: changedValue(
				was && 'assigneeId' in was ? name(str(was.assigneeId)) : undefined,
				name(input.assigneeId),
			),
			path: 'assigneeId',
		});
	}
	if (input.dueDate !== undefined || input.dueTime !== undefined) {
		const today = todayIn(c.timeZone, Date.now());
		const due = (dueDate: string | null, dueTime: string | null) =>
			dueDate ? dueLabel({ dueDate, dueTime }, today, t, c.formatLocale, c.hourCycle) : t('no_due');
		const oldDate = str(was?.dueDate);
		const oldTime = str(was?.dueTime);
		const newDate = input.dueDate !== undefined ? input.dueDate : oldDate;
		const newTime = input.dueTime !== undefined ? input.dueTime : oldTime;
		fields.push({
			label: t('due'),
			value:
				was && 'dueDate' in was
					? changedValue(due(oldDate, oldTime), due(newDate, newDate ? newTime : null))
					: due(input.dueDate ?? null, input.dueTime ?? null),
			paths: ['dueDate', 'dueTime'],
		});
	}
	if (input.notes !== undefined)
		fields.push({
			label: t('notes'),
			value: changedValue(
				was && 'notes' in was ? (str(was.notes) ?? '—') : undefined,
				input.notes || '—',
			),
			path: 'notes',
		});
	return fields;
}
