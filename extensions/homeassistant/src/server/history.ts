import { defineRoute, type JobContext } from '@famos/sdk';
import {
	MAX_HISTORY,
	type SwitchEntry,
	SwitchHistoryQuerySchema,
	SwitchHistorySchema,
} from '../contract/index.ts';
import { homeassistantView } from './capabilities.ts';
import { tables } from './store.ts';

/**
 * Who switched what: one row per switch the queue finished, kept for a few weeks. It holds the
 * family's name for the item at the time, so it still reads right after the item is renamed or
 * removed. It holds no state of the home, only the order that was given and whether it went.
 */

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;

export async function recordSwitch(
	ctx: JobContext,
	entry: {
		id: string;
		itemId: string;
		entityId: string;
		label: string;
		operation: string;
		memberId: string | null;
		ok: boolean;
	},
): Promise<void> {
	const now = ctx.clock.now();
	const db = tables(ctx.db);
	// The job's id is the row's: running the job twice writes it once.
	await db
		.insertInto('homeassistant_switches')
		.values({
			id: entry.id,
			item_id: entry.itemId,
			entity_id: entry.entityId,
			label: entry.label,
			operation: entry.operation,
			member_id: entry.memberId,
			ok: entry.ok ? 1 : 0,
			at: now,
		})
		.onConflict((c) => c.column('id').doNothing())
		.execute();
	await db
		.deleteFrom('homeassistant_switches')
		.where('at', '<', now - KEEP_MS)
		.execute();
}

export const getSwitchHistory = defineRoute({
	method: 'get',
	path: '/switches',
	operationId: 'homeassistant.getSwitchHistory',
	summary: 'The latest switches, newest first, optionally of one item',
	requires: homeassistantView.id,
	query: SwitchHistoryQuerySchema,
	response: SwitchHistorySchema,
	async handle(ctx, { actor, query }) {
		let select = tables(ctx.db).selectFrom('homeassistant_switches').selectAll();
		if (query.itemId) select = select.where('item_id', '=', query.itemId);
		const rows = await select
			.orderBy('at', 'desc')
			.orderBy('id', 'desc')
			.limit(Math.min(query.limit ?? DEFAULT_LIMIT, MAX_HISTORY))
			.execute();
		return {
			entries: rows.map(
				(row): SwitchEntry => ({
					id: row.id,
					itemId: row.item_id,
					entityId: row.entity_id as SwitchEntry['entityId'],
					label: row.label,
					operation: row.operation as SwitchEntry['operation'],
					// A family display shows no names unless it was granted them.
					memberId: actor.kind === 'display' && !actor.showNames ? null : row.member_id,
					ok: row.ok === 1,
					at: row.at,
				}),
			),
		};
	},
});
