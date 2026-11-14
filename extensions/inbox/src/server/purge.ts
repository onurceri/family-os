import { defineJob, type JobContext } from '@famos/sdk';
import { z } from 'zod';
import { filesOf, tables } from './store.ts';

export const PURGE_FILES_JOB = 'inbox.removeFiles';

/** Dismissed items one sweep cleans up, so a long backlog never holds up the sweep. */
export const PURGE_BATCH = 50;

/**
 * Deletes the files of a dismissed item, once. An item filed on a record keeps them: the record
 * holds those files now, whatever happens to the capture. Safe to run again: deleting a missing
 * file does nothing and an item already cleaned is left alone.
 */
export async function removeItemFiles(ctx: JobContext, itemId: string): Promise<void> {
	const row = await tables(ctx.db)
		.selectFrom('inbox_items')
		.selectAll()
		.where('id', '=', itemId)
		.executeTakeFirst();
	if (row?.status !== 'dismissed' || row.filed_to !== null || row.files_removed_at !== null) return;
	for (const file of filesOf(row)) await ctx.files.delete(file.key);
	await ctx.unit(async (uow) => {
		await tables(uow.db)
			.updateTable('inbox_items')
			.set({ files_removed_at: uow.clock.now() })
			.where('id', '=', itemId)
			.execute();
	});
}

/** Dismissed items that still hold files nobody else keeps (the items dismissed before the job). */
export async function dismissedWithFiles(ctx: Pick<JobContext, 'db'>): Promise<string[]> {
	const rows = await tables(ctx.db)
		.selectFrom('inbox_items')
		.select('id')
		.where('status', '=', 'dismissed')
		.where('filed_to', 'is', null)
		.where('files_removed_at', 'is', null)
		.where('files', '!=', '[]')
		.limit(PURGE_BATCH)
		.execute();
	return rows.map((row) => row.id);
}

export const removeFilesJob = defineJob({
	name: PURGE_FILES_JOB,
	payload: z.object({ itemId: z.string() }),
	async handle(ctx, { itemId }) {
		await removeItemFiles(ctx, itemId);
	},
});
