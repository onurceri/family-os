import type { DbExecutor } from '@famos/sdk';
import { WAITING_STATUSES } from './draft-expiry.ts';
import type { CoreTables } from './tables.ts';

/** The notice kind that tells approvers a suggestion waits. */
export const WAITING_KIND = 'core.draftWaiting';

/** The notice kind that tells the person behind a suggestion what became of it. */
export const DECIDED_KIND = 'core.draftDecided';

/** Suggestions made from one shared item share one notice; any other has its own. */
export function waitingDedupeKey(draft: {
	id: string;
	sourceKind: string | null;
	sourceId: string | null;
}): string {
	return draft.sourceKind && draft.sourceId
		? `drafts:${draft.sourceKind}:${draft.sourceId}`
		: `draft:${draft.id}`;
}

/**
 * What counts as one thing to decide: the suggestions made from one item a member shared with the
 * AI to read are one (they are decided together, as a group); any other suggestion is its own.
 */
export function waitingUnit(draft: {
	id: string;
	source_kind: string | null;
	source_id: string | null;
	proposed_by: string;
}): string {
	const by = JSON.parse(draft.proposed_by) as { kind?: string; mode?: string };
	return by.kind === 'ai' && by.mode === 'share' && draft.source_kind && draft.source_id
		? `share:${draft.source_kind}:${draft.source_id}`
		: `draft:${draft.id}`;
}

/** Whether a suggestion behind this notice key still waits for a decision. */
export async function stillWaiting(db: DbExecutor, dedupeKey: string): Promise<boolean> {
	const waiting = db
		.withTables<CoreTables>()
		.selectFrom('core_drafts')
		.select('id')
		.where('status', 'in', [...WAITING_STATUSES]);
	if (dedupeKey.startsWith('drafts:')) {
		const [, kind = '', ...rest] = dedupeKey.split(':');
		const row = await waiting
			.where('source_kind', '=', kind)
			.where('source_id', '=', rest.join(':'))
			.executeTakeFirst();
		return row !== undefined;
	}
	const row = await waiting.where('id', '=', dedupeKey.slice('draft:'.length)).executeTakeFirst();
	return row !== undefined;
}

/**
 * Marks the "waiting" notices of a decided suggestion as read, unless another suggestion of
 * the same shared item still waits. Returns the members whose unread count changed.
 */
export async function settleWaitingNotices(
	db: DbExecutor,
	draft: { id: string; source_kind: string | null; source_id: string | null },
	now: number,
): Promise<string[]> {
	const key = waitingDedupeKey({
		id: draft.id,
		sourceKind: draft.source_kind,
		sourceId: draft.source_id,
	});
	if (await stillWaiting(db, key)) return [];
	const unread = await db
		.withTables<CoreTables>()
		.selectFrom('core_notifications')
		.select(['id', 'member_id'])
		.where('kind', '=', WAITING_KIND)
		.where('dedupe_key', '=', key)
		.where('read_at', 'is', null)
		.execute();
	if (unread.length === 0) return [];
	await db
		.withTables<CoreTables>()
		.updateTable('core_notifications')
		.set({ read_at: now })
		.where(
			'id',
			'in',
			unread.map((n) => n.id),
		)
		.execute();
	return [...new Set(unread.map((n) => n.member_id))];
}
