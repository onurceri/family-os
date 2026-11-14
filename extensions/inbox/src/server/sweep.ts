import { defineJob, type ExtensionContext } from '@famos/sdk';
import { z } from 'zod';
import { READ_MAX_LIFE_MS, SWEEP_EVERY_MS } from './budget.ts';
import { itemChanged } from './items.ts';
import { dismissedWithFiles, removeItemFiles } from './purge.ts';
import { ITEM_KIND, tables } from './store.ts';

export const SWEEP_JOB = 'inbox.sweep';

const sweepKey = (at: number) => `${SWEEP_JOB}:${at}`;

/** Plans the next sweep (once per slot: the key names it). */
export async function scheduleSweep(ctx: Pick<ExtensionContext, 'enqueue' | 'clock'>) {
	const at = (Math.floor(ctx.clock.now() / SWEEP_EVERY_MS) + 1) * SWEEP_EVERY_MS;
	await ctx.enqueue(SWEEP_JOB, {}, { runAt: at, dedupeKey: sweepKey(at) });
}

/**
 * Fails the items a reading left `received` or `normalized` past the longest life of its job (the
 * server stopped on the last attempt), so the item shows as failed with a working Retry. Safe to
 * run twice: an item already decided or read is left alone. It also deletes the files of items
 * dismissed before dismissing did, a batch at a time.
 */
export const sweepJob = defineJob({
	name: SWEEP_JOB,
	payload: z.object({}),
	async handle(ctx) {
		try {
			const stuck = await tables(ctx.db)
				.selectFrom('inbox_items')
				.select(['id', 'created_by'])
				.where('status', 'in', ['received', 'normalized'])
				.where('updated_at', '<', ctx.clock.now() - READ_MAX_LIFE_MS)
				.execute();
			for (const item of stuck) {
				await ctx.unit(async (uow) => {
					const failed = await tables(uow.db)
						.updateTable('inbox_items')
						.set({
							status: 'failed',
							error_code: 'unavailable',
							read_attempt: null,
							updated_at: uow.clock.now(),
						})
						.where('id', '=', item.id)
						.where('status', 'in', ['received', 'normalized'])
						.executeTakeFirst();
					if (Number(failed.numUpdatedRows) === 0) return;
					await uow.ai.reindex(ITEM_KIND, item.id);
					uow.emit(itemChanged, { itemId: item.id, memberId: item.created_by });
				});
			}
			// Items dismissed before the files went with them.
			for (const id of await dismissedWithFiles(ctx)) await removeItemFiles(ctx, id);
		} finally {
			await scheduleSweep(ctx);
		}
	},
});
