import {
	DEFAULT_REMINDER_TIME,
	defineJob,
	defineNotificationKind,
	type EnqueueJob,
	reminderMissed,
	reminderStale,
} from '@famos/sdk';
import { dayBounds, epochOf } from '@famos/time';
import { z } from 'zod';
import { type TaskRow, tables } from './store.ts';

/**
 * Task reminders: a task with a due date reminds its assignee (everyone who can see lists when
 * nobody is assigned) at the due time, or 09:00 when it has none. One `lists.remind` job per task
 * is planned in the transaction of every change; it carries the due date, time and `updated_at`
 * it was planned for, so a job that no longer matches (edited, done, deleted) does nothing.
 * A repeating task is planned again when its completion moves the due date.
 */
export const taskDueKind = defineNotificationKind({
	id: 'lists.taskDue',
	label: 'lists:notify_kind_task_due',
	audience: 'lists.view',
});

const RemindPayload = z.object({
	taskId: z.string(),
	dueDate: z.string(),
	dueTime: z.string().nullable(),
	version: z.number(),
});

/** Plans the reminder of an open task with a due date. */
export async function scheduleTaskReminder(
	enqueue: EnqueueJob,
	row: TaskRow,
	now: number,
	timeZone: string,
): Promise<void> {
	if (!row.due_date || row.done_at !== null || row.deleted_at !== null) return;
	const at = epochOf(row.due_date, row.due_time ?? DEFAULT_REMINDER_TIME, timeZone);
	if (reminderMissed(at, now)) return;
	await enqueue(
		'lists.remind',
		{ taskId: row.id, dueDate: row.due_date, dueTime: row.due_time, version: row.updated_at },
		{ runAt: at, dedupeKey: `lists.remind:${row.id}:${row.due_date}:${row.updated_at}` },
	);
}

export const remindJob = defineJob({
	name: 'lists.remind',
	payload: RemindPayload,
	async handle(ctx, { taskId, dueDate, dueTime, version }) {
		const row = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.selectAll()
			.where('id', '=', taskId)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row || row.done_at !== null) return;
		if (
			reminderStale({ version, date: dueDate }, { version: row.updated_at, date: row.due_date }) ||
			row.due_time !== dueTime
		)
			return;

		const { timeZone } = await ctx.family.settings();
		// The job may have waited a long time (server down): do not remind about a past day.
		if (ctx.clock.now() >= dayBounds(dueDate, timeZone).end) return;
		await ctx.notify({
			kind: taskDueKind.id,
			to: row.assignee_id ? { members: [row.assignee_id] } : { capability: 'lists.view' },
			title: { key: 'lists:task_due_title', params: { title: row.title } },
			body: dueTime
				? {
						key: 'lists:task_due_at',
						params: { time: { time: dueTime } },
					}
				: { key: 'lists:task_due_today' },
			url: '/lists/tasks',
			source: { kind: 'lists.task', id: row.id },
			dedupeKey: `reminder:${row.id}:${dueDate}`,
		});
	},
});
