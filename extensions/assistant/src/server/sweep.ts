import { defineJob, type ExtensionContext } from '@famos/sdk';
import { z } from 'zod';
import { SWEEP_JOB } from '../contract/index.ts';
import { SWEEP_EVERY_MS, TURN_MAX_LIFE_MS } from './budget.ts';
import { tables } from './store.ts';
import { failOpenReply } from './turn.ts';

const sweepKey = (at: number) => `${SWEEP_JOB}:${at}`;

/** Plans the next sweep (once per slot: the key names it). */
export async function scheduleSweep(ctx: Pick<ExtensionContext, 'enqueue' | 'clock'>) {
	const at = (Math.floor(ctx.clock.now() / SWEEP_EVERY_MS) + 1) * SWEEP_EVERY_MS;
	await ctx.enqueue(SWEEP_JOB, {}, { runAt: at, dedupeKey: sweepKey(at) });
}

/**
 * Finishes as failed the replies a turn left `pending` or `streaming` past the longest life of
 * its job (a crash, a job that ended without a word), so the thread accepts a new question.
 * Safe to run twice: a reply already decided is left alone.
 */
export const sweepJob = defineJob({
	name: SWEEP_JOB,
	payload: z.object({}),
	async handle(ctx) {
		try {
			const open = await tables(ctx.db)
				.selectFrom('assistant_messages')
				.select(['id', 'thread_id'])
				.where('role', '=', 'assistant')
				.where('status', 'in', ['pending', 'streaming'])
				.where('created_at', '<', ctx.clock.now() - TURN_MAX_LIFE_MS)
				.execute();
			for (const reply of open)
				await failOpenReply(ctx, { threadId: reply.thread_id, messageId: reply.id });
		} finally {
			await scheduleSweep(ctx);
		}
	},
});
