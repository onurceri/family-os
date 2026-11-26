import { defineJob, defineNotificationKind, type ExtensionContext } from '@famos/sdk';
import { addDays, epochOf, todayIn } from '@famos/time';
import { z } from 'zod';
import { CHORES_VIEW } from '../contract/index.ts';
import { tables } from './store.ts';

/**
 * The evening count: once a day, at `LEFT_TODAY_AT` in the family time zone, each person with
 * chores still open for them (due today or late, their turn) hears how many. Only those who
 * switched it on hear it (`optIn`), so the job tells everyone with something open and core leaves
 * out the rest. A chore anyone may do counts for nobody, as with the morning reminder.
 */
export const leftTodayKind = defineNotificationKind({
	id: 'chores.leftToday',
	label: 'chores:notify_kind_left_today',
	audience: CHORES_VIEW,
	optIn: true,
});

/** The family's local time of the evening count. */
export const LEFT_TODAY_AT = '18:00';

export const LEFT_TODAY_JOB = 'chores.leftToday';

/**
 * Plans the next evening count: today's when it is still ahead, else tomorrow's. The key names
 * the instant, so a running count that plans the next one never finds itself, and a time zone
 * changed since gives a new slot.
 */
export async function scheduleLeftToday(
	ctx: Pick<ExtensionContext, 'enqueue' | 'clock' | 'family'>,
): Promise<void> {
	const { timeZone } = await ctx.family.settings();
	const now = ctx.clock.now();
	const today = todayIn(timeZone, now);
	let at = epochOf(today, LEFT_TODAY_AT, timeZone);
	if (at <= now) at = epochOf(addDays(today, 1), LEFT_TODAY_AT, timeZone);
	await ctx.enqueue(LEFT_TODAY_JOB, {}, { runAt: at, dedupeKey: `${LEFT_TODAY_JOB}:${at}` });
}

/**
 * Counts and tells, then plans the next count whatever happened. "Today" is decided when it runs:
 * a count that waited past midnight (the server was down) speaks of the new day only once that
 * day's evening comes, and one planned before a time zone change waits for the evening in the new
 * zone. Running twice tells nobody twice: each notice is keyed by person and day.
 */
export const leftTodayJob = defineJob({
	name: LEFT_TODAY_JOB,
	payload: z.object({}),
	async handle(ctx) {
		try {
			const { timeZone } = await ctx.family.settings();
			const now = ctx.clock.now();
			const today = todayIn(timeZone, now);
			if (now < epochOf(today, LEFT_TODAY_AT, timeZone)) return;

			const open = await tables(ctx.db)
				.selectFrom('chores_chores')
				.select(['assignee_id', (eb) => eb.fn.countAll<number>().as('n')])
				.where('archived_at', 'is', null)
				.where('next_due', 'is not', null)
				.where('next_due', '<=', today)
				.where('assignee_id', 'is not', null)
				.groupBy('assignee_id')
				.execute();
			const active = new Set((await ctx.family.members()).map((m) => m.id));
			for (const { assignee_id: memberId, n } of open) {
				if (memberId === null || !active.has(memberId)) continue;
				const count = Number(n);
				await ctx.notify({
					kind: leftTodayKind.id,
					to: { members: [memberId] },
					title: { key: 'chores:left_today_title', params: { count } },
					body: { key: 'chores:left_today_body' },
					url: '/chores',
					dedupeKey: `${LEFT_TODAY_JOB}:${memberId}:${today}`,
				});
			}
		} finally {
			await scheduleLeftToday(ctx);
		}
	},
});
