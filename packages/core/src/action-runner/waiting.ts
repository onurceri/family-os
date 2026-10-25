import {
	type ActionTarget,
	type Actor,
	type DbExecutor,
	memberBehind,
	systemActor,
} from '@famos/sdk';
import { todayIn } from '@famos/time';
import { draftUpdated, notificationRead } from '../core-events.ts';
import { draftDateOf, hasPassed, WAITING_STATUSES } from '../draft-expiry.ts';
import { settleWaitingNotices } from '../draft-notices.ts';
import { familyReader } from '../family.ts';
import { ownerOf } from '../features.ts';
import { readStoredInput } from '../stored-input.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { Admission } from './admission.ts';
import type { Deciders } from './deciders.ts';
import type { RowWithId } from './shared.ts';
import type { ActionRunner, ActionRunnerDeps, GoneFacts, PassedFacts } from './types.ts';
import type { UnitOfWorkParts } from './unit-of-work.ts';

/**
 * The suggestions still waiting: which a caller sees, which no longer wait because their day
 * passed or what they are about is gone, and marking those expired.
 */
export function createWaiting(
	deps: ActionRunnerDeps,
	{
		can,
		coreDb,
		mayDecide,
		draftVisibleTo,
		unavailable,
		unitOfWork,
	}: Admission & Deciders & UnitOfWorkParts,
) {
	const { registry, bus, clock, logger } = deps;
	async function waitingFor(
		actor: Actor,
		options: Parameters<ActionRunner['waitingFor']>[1] = {},
	): Promise<DraftRow[]> {
		const member = memberBehind(actor);
		let query = coreDb()
			.selectFrom('core_drafts')
			.selectAll()
			.where('status', 'in', [...(options.statuses ?? WAITING_STATUSES)]);
		const about = options.about;
		if (about && 'draftId' in about) query = query.where('id', '=', about.draftId);
		else if (about)
			query = query
				.where('source_kind', '=', about.sourceKind)
				.where('source_id', '=', about.sourceId);
		const all = await query
			.where((eb) =>
				member !== null
					? eb.or([eb('for_member', 'is', null), eb('for_member', '=', member)])
					: eb('for_member', 'is', null),
			)
			.orderBy('created_at', options.oldestFirst ? 'asc' : 'desc')
			.orderBy('id', options.oldestFirst ? 'asc' : 'desc')
			.execute();
		const seen = options.decidableOnly
			? all.filter((row) => mayDecide(row, actor))
			: all.filter((row) => draftVisibleTo(actor, row));
		const passed = await passedCheck();
		const open = seen.filter((row) => !passed(row));
		const gone = await goneAmong(open);
		return open.filter((row) => !gone.has(row.id));
	}

	async function visibleDraftIds(actor: Actor, ids: readonly string[]): Promise<Set<string>> {
		if (ids.length === 0 || !can(actor, 'core.drafts.propose')) return new Set();
		const rows = await coreDb()
			.selectFrom('core_drafts')
			.selectAll()
			.where('id', 'in', [...ids])
			.execute();
		return new Set(rows.filter((row) => draftVisibleTo(actor, row)).map((row) => row.id));
	}

	async function passedCheck(db: DbExecutor = deps.db): Promise<(draft: PassedFacts) => boolean> {
		const { timeZone } = await familyReader(db).settings();
		const today = todayIn(timeZone, clock.now());
		return (draft) =>
			(WAITING_STATUSES as readonly string[]).includes(draft.status) &&
			hasPassed(draftDateOf(registry.actions.get(draft.action_id), draft), today);
	}

	async function goneAmong(
		drafts: readonly GoneFacts[],
		db: DbExecutor = deps.db,
	): Promise<ReadonlySet<string>> {
		// Drafts by the row they work on: one query per table and live column.
		const groups = new Map<
			string,
			{
				extension: string;
				table: string;
				idColumn: string;
				liveColumn?: string;
				ids: Map<string, string[]>;
			}
		>();
		for (const draft of drafts) {
			if (!(WAITING_STATUSES as readonly string[]).includes(draft.status)) continue;
			const def = registry.actions.get(draft.action_id);
			// Not installed or turned off is its own state (`unavailable`), not a gone target.
			if (!def?.target || unavailable(draft)) continue;
			let target: ActionTarget | null = null;
			try {
				const input = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
				if (input.success) target = def.target(input.data);
			} catch {
				// An input stored by another version may not fit today's shape: it is not judged.
			}
			if (!target) continue;
			const extension = ownerOf(def.id);
			const idColumn = target.idColumn ?? 'id';
			const key = `${extension}:${target.table}:${idColumn}:${target.liveColumn ?? ''}`;
			const group = groups.get(key) ?? {
				extension,
				table: target.table,
				idColumn,
				...(target.liveColumn && { liveColumn: target.liveColumn }),
				ids: new Map<string, string[]>(),
			};
			group.ids.set(target.id, [...(group.ids.get(target.id) ?? []), draft.id]);
			groups.set(key, group);
		}
		const gone = new Set<string>();
		for (const group of groups.values()) {
			try {
				const tables = deps.views.db(group.extension, db).withTables<Record<string, RowWithId>>();
				let query = tables
					.selectFrom(group.table)
					.select(group.idColumn)
					.where(group.idColumn, 'in', [...group.ids.keys()]);
				if (group.liveColumn) query = query.where(group.liveColumn, 'is', null);
				const live = new Set((await query.execute()).map((row) => row[group.idColumn]));
				for (const [id, draftIds] of group.ids)
					if (!live.has(id)) for (const draftId of draftIds) gone.add(draftId);
			} catch (error) {
				// A table that cannot be read judges nothing: the drafts stay as they are.
				logger.warn({ err: error, table: group.table }, 'checking the targets of drafts failed');
			}
		}
		return gone;
	}

	async function expirePassed(): Promise<number> {
		const passed = await passedCheck();
		const waiting = await coreDb()
			.selectFrom('core_drafts')
			.select([
				'id',
				'action_id',
				'status',
				'input',
				'edited_input',
				'source_kind',
				'source_id',
				'for_member',
			])
			.where('status', 'in', [...WAITING_STATUSES])
			.execute();
		let expired = 0;
		for (const draft of waiting.filter(passed)) {
			const now = clock.now();
			// Only if still waiting (a person may have decided it meanwhile); the write and its
			// entry in the change log are one transaction.
			const done = await unitOfWork(systemActor('core'), async (uow) => {
				const result = await uow.db
					.withTables<CoreTables>()
					.updateTable('core_drafts')
					.set({ status: 'expired', decided_at: now, updated_at: now })
					.where('id', '=', draft.id)
					.where('status', 'in', [...WAITING_STATUSES])
					.executeTakeFirst();
				if (Number(result.numUpdatedRows) === 0) return false;
				uow.emit(draftUpdated, {
					draftId: draft.id,
					status: 'expired',
					forMember: draft.for_member,
				});
				return true;
			});
			if (!done) continue;
			expired++;
			for (const memberId of await settleWaitingNotices(deps.db, draft))
				await bus.publish(notificationRead.name, { memberId });
		}
		return expired;
	}

	return { waitingFor, visibleDraftIds, passedCheck, goneAmong, expirePassed };
}

export type Waiting = ReturnType<typeof createWaiting>;
