import {
	defineJob,
	defineNotificationKind,
	type EnqueueJob,
	type ReminderSettings,
	reminderMissed,
	reminderStale,
} from '@famos/sdk';
import { dayBounds, epochOf } from '@famos/time';
import { z } from 'zod';
import { CHORES_VIEW } from '../contract/index.ts';
import { type ChoreRow, tables } from './store.ts';

/**
 * Chore reminders: on the day a chore is due, at the family's reminder time, whoever is up
 * hears about it. A chore anyone may do reminds nobody. One `chores.remind` job per chore is
 * planned in the transaction of every change; it carries the due date and the `updated_at` it was
 * planned for, so a job that no longer matches (done, edited, handed over, archived) does nothing.
 */
export const choreDueKind = defineNotificationKind({
	id: 'chores.choreDue',
	label: 'chores:notify_kind_chore_due',
	audience: CHORES_VIEW,
});

const RemindPayload = z.object({
	choreId: z.string(),
	dueDate: z.string(),
	version: z.number(),
});

/** Plans the reminder of a chore as it is now. */
export async function scheduleChoreReminder(
	enqueue: EnqueueJob,
	row: ChoreRow,
	now: number,
	{ timeZone, reminderTime }: ReminderSettings,
): Promise<void> {
	if (row.archived_at !== null || !row.next_due || !row.assignee_id) return;
	const at = epochOf(row.next_due, reminderTime, timeZone);
	if (reminderMissed(at, now)) return;
	await enqueue(
		'chores.remind',
		{ choreId: row.id, dueDate: row.next_due, version: row.updated_at },
		{ runAt: at, dedupeKey: `chores.remind:${row.id}:${row.next_due}:${row.updated_at}` },
	);
}

export const remindJob = defineJob({
	name: 'chores.remind',
	payload: RemindPayload,
	async handle(ctx, { choreId, dueDate, version }) {
		const row = await tables(ctx.db)
			.selectFrom('chores_chores')
			.selectAll()
			.where('id', '=', choreId)
			.executeTakeFirst();
		if (!row || row.archived_at !== null || !row.assignee_id) return;
		if (reminderStale({ version, date: dueDate }, { version: row.updated_at, date: row.next_due }))
			return;

		const { timeZone, reminderTime } = await ctx.family.settings();
		const now = ctx.clock.now();
		// The job may have waited a long time (server down): do not remind about a past day.
		if (now >= dayBounds(dueDate, timeZone).end) return;
		// The family moved the reminder time later since this was planned: wait for it.
		const at = epochOf(dueDate, reminderTime, timeZone);
		if (at > now) {
			await ctx.enqueue(
				'chores.remind',
				{ choreId, dueDate, version },
				{ runAt: at, dedupeKey: `chores.remind:${choreId}:${dueDate}:${version}:${at}` },
			);
			return;
		}
		await ctx.notify({
			kind: choreDueKind.id,
			to: { members: [row.assignee_id] },
			title: { key: 'chores:chore_due_title', params: { title: row.title } },
			body: { key: 'chores:chore_due_today' },
			url: '/chores',
			source: { kind: 'chores.chore', id: row.id },
			dedupeKey: `reminder:${row.id}:${dueDate}`,
		});
	},
});
