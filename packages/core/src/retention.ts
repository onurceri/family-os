import { DAY_MS, defineJob, type ExtensionContext } from '@famos/sdk';
import { z } from 'zod';
import { notificationRead } from './core-events.ts';
import type { CoreTables, DraftRow } from './tables.ts';

/** A decided suggestion is kept this long after its last decision, then removed. */
export const DECIDED_DRAFTS_KEEP_MS = 90 * DAY_MS;
/** A notification is kept this long after it was made, read or not. */
export const NOTIFICATIONS_KEEP_MS = 90 * DAY_MS;

/** Statuses nothing changes any more (an applied one may still be undone; see `keepApplied`). */
const DECIDED = ['rejected', 'undone', 'expired'] as const;
/** Applied drafts judged at once. */
const BATCH = 500;

export const PRUNE_HISTORY_JOB = 'core.pruneHistory';

export interface RetentionDeps {
	/**
	 * Whether an applied draft stays whatever its age: its undo is still offered, or its action is
	 * not installed now (a reinstall may offer its undo again).
	 */
	keepApplied(draft: Pick<DraftRow, 'action_id' | 'status' | 'result'>): boolean;
}

/**
 * Old decided suggestions and old notifications go once a day, so a family running for years
 * does not carry them in every list, count and backup. The audit log stays: it is the history.
 */
export function createRetention(deps: RetentionDeps) {
	const job = defineJob({
		name: PRUNE_HISTORY_JOB,
		payload: z.object({}),
		maxAttempts: 3,
		async handle(ctx) {
			const now = ctx.clock.now();
			const db = ctx.db.withTables<CoreTables>();
			const draftsBefore = now - DECIDED_DRAFTS_KEEP_MS;
			// A decided draft changes no more after its last decision (an undo updates it too).
			await db
				.deleteFrom('core_drafts')
				.where('status', 'in', [...DECIDED])
				.where('updated_at', '<', draftsBefore)
				.execute();
			let last = '';
			for (;;) {
				const applied = await db
					.selectFrom('core_drafts')
					.select(['id', 'action_id', 'status', 'result'])
					.where('status', '=', 'applied')
					.where('updated_at', '<', draftsBefore)
					.where('id', '>', last)
					.orderBy('id')
					.limit(BATCH)
					.execute();
				const drop = applied.filter((row) => !deps.keepApplied(row)).map((row) => row.id);
				if (drop.length > 0)
					await db
						.deleteFrom('core_drafts')
						.where('id', 'in', drop)
						.where('status', '=', 'applied')
						.execute();
				if (applied.length < BATCH) break;
				last = (applied.at(-1) as { id: string }).id;
			}

			const notificationsBefore = now - NOTIFICATIONS_KEEP_MS;
			await ctx.unit(async (uow) => {
				const tables = uow.db.withTables<CoreTables>();
				// Whose unread count goes down: their screens refresh it.
				const unread = await tables
					.selectFrom('core_notifications')
					.select('member_id')
					.distinct()
					.where('created_at', '<', notificationsBefore)
					.where('read_at', 'is', null)
					.execute();
				await tables
					.deleteFrom('core_notifications')
					.where('created_at', '<', notificationsBefore)
					.execute();
				for (const { member_id } of unread) uow.emit(notificationRead, { memberId: member_id });
			});
			await schedulePruneHistory(ctx, now + DAY_MS);
		},
	});
	return { job };
}

/** One pending job per day, so restarts and the job's own rescheduling never pile up. */
export async function schedulePruneHistory(
	ctx: Pick<ExtensionContext, 'enqueue'>,
	runAt: number,
): Promise<void> {
	await ctx.enqueue(
		PRUNE_HISTORY_JOB,
		{},
		{ runAt, dedupeKey: `${PRUNE_HISTORY_JOB}:${Math.floor(runAt / DAY_MS)}` },
	);
}
