import {
	defineJob,
	defineNotificationKind,
	type EnqueueJob,
	type ReminderSettings,
	reminderMissed,
	reminderStale,
} from '@famos/sdk';
import { addDays, dayBounds, daysBetween, epochOf, todayIn } from '@famos/time';
import { z } from 'zod';
import { DEFAULT_AUDIENCE } from '../contract/index.ts';
import { type ObligationRow, tables } from './store.ts';

/**
 * Obligation reminders: the assignee, or everyone who holds the obligation's
 * audience capability when nobody is assigned, hears about it `lead_days` before the due date and
 * again on the due date, at the family's reminder time. Only the current due date is planned; every change
 * plans afresh in its own transaction, and a job carries the due date and `updated_at` it was
 * planned for, so a job that no longer matches (edited, done, removed, archived) does nothing.
 */
export const obligationDueKind = defineNotificationKind({
	id: 'records.obligationDue',
	label: 'records:notify_kind_obligation_due',
	audience: 'records.view',
});

const RemindPayload = z.object({
	obligationId: z.string(),
	dueDate: z.string(),
	stage: z.enum(['lead', 'due']),
	version: z.number(),
});

/** Plans the reminders of an open obligation as it is now. */
export async function scheduleObligationReminders(
	enqueue: EnqueueJob,
	row: ObligationRow,
	now: number,
	{ timeZone, reminderTime }: ReminderSettings,
): Promise<void> {
	if (row.archived_at !== null) return;
	const stages: { stage: 'lead' | 'due'; date: string }[] = [];
	if (row.lead_days > 0)
		stages.push({ stage: 'lead', date: addDays(row.due_date, -row.lead_days) });
	stages.push({ stage: 'due', date: row.due_date });
	for (const { stage, date } of stages) {
		const at = epochOf(date, reminderTime, timeZone);
		if (reminderMissed(at, now)) continue;
		await enqueue(
			'records.remind',
			{ obligationId: row.id, dueDate: row.due_date, stage, version: row.updated_at },
			{
				runAt: at,
				dedupeKey: `records.remind:${row.id}:${row.due_date}:${stage}:${row.updated_at}`,
			},
		);
	}
}

export const remindJob = defineJob({
	name: 'records.remind',
	payload: RemindPayload,
	async handle(ctx, { obligationId, dueDate, stage, version }) {
		const row = await tables(ctx.db)
			.selectFrom('records_obligations')
			.selectAll()
			.where('id', '=', obligationId)
			.executeTakeFirst();
		if (!row || row.archived_at !== null) return;
		if (reminderStale({ version, date: dueDate }, { version: row.updated_at, date: row.due_date }))
			return;

		const { timeZone, reminderTime } = await ctx.family.settings();
		const now = ctx.clock.now();
		// The job may have waited a long time (server down): do not remind about a past day.
		if (now >= dayBounds(dueDate, timeZone).end) return;
		// The family moved the reminder time later since this was planned: wait for it.
		const at = epochOf(
			stage === 'lead' ? addDays(dueDate, -row.lead_days) : dueDate,
			reminderTime,
			timeZone,
		);
		if (at > now) {
			await ctx.enqueue(
				'records.remind',
				{ obligationId, dueDate, stage, version },
				{
					runAt: at,
					dedupeKey: `records.remind:${obligationId}:${dueDate}:${stage}:${version}:${at}`,
				},
			);
			return;
		}

		const today = todayIn(timeZone, now);
		const days = daysBetween(today, dueDate);
		// A date that only passes "ends"; a duty is "due".
		const ends = row.lapses === 1;
		const request = {
			kind: obligationDueKind.id,
			title: {
				key: 'records:obligation_due_title',
				params: { title: row.title, record: row.record_name },
			},
			body:
				days <= 0
					? { key: ends ? 'records:obligation_ends_today' : 'records:obligation_due_today' }
					: {
							key: ends ? 'records:obligation_ends_in' : 'records:obligation_due_in',
							params: { count: days, date: { date: dueDate } },
						},
			url: row.record_url ?? '/',
			source: { kind: 'records.obligation', id: row.id },
			dedupeKey: `obligation:${row.id}:${dueDate}:${stage}`,
		};
		if (row.assignee_id) return ctx.notify({ ...request, to: { members: [row.assignee_id] } });
		try {
			await ctx.notify({ ...request, to: { capability: row.audience } });
		} catch (error) {
			// The domain named a capability that is not (or no longer) declared: fall back to the
			// people who may see records at all, rather than failing the reminder.
			if (row.audience === DEFAULT_AUDIENCE) throw error;
			ctx.logger.warn({ obligationId, audience: row.audience }, 'unknown audience, using default');
			await ctx.notify({ ...request, to: { capability: DEFAULT_AUDIENCE } });
		}
	},
});
