import { defineJob, defineNotificationKind, type ExtensionContext } from '@famos/sdk';
import { addDays, epochOf, todayIn } from '@famos/time';
import { z } from 'zod';
import { CHORES_VIEW, DEFAULT_LEFT_TODAY_TIMES } from '../contract/index.ts';
import { loadLeftTodayTimes, tables } from './store.ts';

/**
 * The evening count: at each of the family's chosen times (18:00 until they choose, family time
 * zone), each person with chores still open for them (due today or late, their turn) hears how
 * many. Only those who switched it on hear it (`optIn`), so the job tells everyone with something
 * open and core leaves out the rest. A chore anyone may do counts for nobody, as with the morning
 * reminder.
 */
export const leftTodayKind = defineNotificationKind({
	id: 'chores.leftToday',
	label: 'chores:notify_kind_left_today',
	audience: CHORES_VIEW,
	optIn: true,
	description: 'chores:notify_kind_left_today_description',
	link: { path: '/chores?reminder=1', label: 'chores:notify_kind_left_today_link' },
});

export const LEFT_TODAY_JOB = 'chores.leftToday';

/** What planning needs: a job's context, a unit of work and the start-up context all have it. */
type Planner = Pick<ExtensionContext, 'enqueue' | 'clock' | 'family' | 'db'>;

/**
 * Plans the next evening count: the first chosen time after now, today's when one is still ahead,
 * else tomorrow's first. The job carries the instant it was planned for and its key names it, so a
 * running count that plans the next one never finds itself, and a changed time or time zone gives
 * a new slot beside the old one (which then finds nothing to tell).
 */
export async function scheduleLeftToday(ctx: Planner): Promise<void> {
	const [{ timeZone }, times] = await Promise.all([
		ctx.family.settings(),
		loadLeftTodayTimes(ctx.db),
	]);
	const now = ctx.clock.now();
	const today = todayIn(timeZone, now);
	const ahead = times.map((time) => epochOf(today, time, timeZone)).find((when) => when > now);
	const first = times[0] ?? DEFAULT_LEFT_TODAY_TIMES[0] ?? '18:00';
	const at = ahead ?? epochOf(addDays(today, 1), first, timeZone);
	await ctx.enqueue(LEFT_TODAY_JOB, { at }, { runAt: at, dedupeKey: `${LEFT_TODAY_JOB}:${at}` });
}

/**
 * Counts and tells, then plans the next count whatever happened. "Today" is decided when it runs,
 * and only the latest chosen time of today that has come, and that this count was planned for or
 * before, is spoken for. So a count that waited past midnight (the server was down) says nothing
 * of the day before, one left over from times or a time zone since changed says nothing, and a
 * time added for earlier today is not told late. Running twice tells nobody twice: each notice is
 * keyed by person, day and time.
 */
export const leftTodayJob = defineJob({
	name: LEFT_TODAY_JOB,
	payload: z.object({ at: z.number().default(0) }),
	async handle(ctx, payload) {
		try {
			const [{ timeZone }, times] = await Promise.all([
				ctx.family.settings(),
				loadLeftTodayTimes(ctx.db),
			]);
			const now = ctx.clock.now();
			const today = todayIn(timeZone, now);
			const slot = times
				.filter((time) => {
					const when = epochOf(today, time, timeZone);
					return payload.at <= when && when <= now;
				})
				.at(-1);
			if (slot === undefined) return;

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
					dedupeKey: `${LEFT_TODAY_JOB}:${memberId}:${today}:${slot}`,
				});
			}
		} finally {
			await scheduleLeftToday(ctx);
		}
	},
});
