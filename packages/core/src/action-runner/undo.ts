import { type Actor, FamosError, personPresent, type UndoStep } from '@famos/sdk';
import { DEFAULT_DRAFT_NOTIFY_DELAY_MS, waitingNotice } from '../auto-approval.ts';
import { draftCreated, draftUpdated } from '../core-events.ts';
import { refusalError } from '../decide.ts';
import { readStoredInput } from '../stored-input.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { Admission } from './admission.ts';
import type { Deciders } from './deciders.ts';
import type { Labels } from './labels.ts';
import { DECIDED } from './shared.ts';
import type { ActionRunnerDeps } from './types.ts';
import type { UnitOfWorkParts } from './unit-of-work.ts';
import type { Waiting } from './waiting.ts';

/** Taking back an applied suggestion, and sending an undone one again as a new suggestion. */
export function createUndo(
	deps: ActionRunnerDeps,
	{
		can,
		getAction,
		coreDb,
		getDraft,
		assertAddressee,
		assertApprover,
		mayDecide,
		isProposer,
		unitOfWork,
		audit,
		draftTargetOf,
		passedCheck,
		proposerLabel,
	}: Admission & Deciders & UnitOfWorkParts & Waiting & Labels,
) {
	const { registry, clock, ids } = deps;
	function undoStep(draft: Pick<DraftRow, 'action_id' | 'status' | 'result'>): UndoStep | null {
		if (draft.status !== 'applied' || draft.result === null) return null;
		const def = registry.actions.get(draft.action_id);
		if (!def?.undo) return null;
		// Results stored by an older version may not match today's output shape: not undoable.
		const output = def.output.safeParse(JSON.parse(draft.result));
		return output.success ? def.undo(output.data) : null;
	}

	async function undoDraft(draftId: string, approver: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(approver, draft);
		if (draft.status === 'undone') return draft; // idempotent
		const step = undoStep(draft);
		if (!step) throw new FamosError('conflict', `Draft is ${draft.status} and cannot be undone`);
		assertApprover(approver, getAction(draft.action_id), draft);
		await unitOfWork(
			approver,
			async (uow) => {
				// Claimed before the inverse runs, so two undos never both run it.
				const claimed = await uow.db
					.withTables<CoreTables>()
					.updateTable('core_drafts')
					.set({ status: 'undone', updated_at: clock.now() })
					.where('id', '=', draftId)
					.where('status', '=', 'applied')
					.executeTakeFirst();
				if (Number(claimed.numUpdatedRows) === 0) {
					const current = await getDraft(uow.db, draftId);
					if (current.status === 'undone') return; // idempotent
					throw new FamosError('conflict', `Draft is ${current.status} and cannot be undone`);
				}
				await uow.run(step.actionId, step.input);
				await audit(uow, draft.action_id, 'undone', draftId, draftTargetOf(draft));
				uow.emit(draftUpdated, { draftId, status: 'undone', forMember: draft.for_member });
			},
			DECIDED,
		);
		return getDraft(deps.db, draftId);
	}

	const againKey = (draftId: string) => `again:${draftId}`;

	async function suggestedAgain(draft: DraftRow): Promise<boolean> {
		if (draft.status !== 'undone') return false;
		const row = await coreDb()
			.selectFrom('core_drafts')
			.select('id')
			.where('dedupe_key', '=', againKey(draft.id))
			.executeTakeFirst();
		return row !== undefined;
	}

	async function suggestAgain(draftId: string, actor: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(actor, draft);
		if (!isProposer(actor, draft) || !personPresent(actor))
			throw new FamosError('forbidden', 'Only the person who suggested it can suggest it again');
		if (draft.status !== 'undone')
			throw new FamosError(
				'conflict',
				`Draft is ${draft.status}; only an undone one is suggested again`,
			);
		const def = getAction(draft.action_id);
		if (!can(actor, 'core.drafts.propose') && !mayDecide(draft, actor))
			throw refusalError({ reason: 'approval', capability: 'core.drafts.propose' });
		const dedupeKey = againKey(draft.id);
		const existing = await coreDb()
			.selectFrom('core_drafts')
			.selectAll()
			.where('dedupe_key', '=', dedupeKey)
			.executeTakeFirst();
		if (existing) return existing; // idempotent
		// What it applied, edits included, is what is suggested again (stored as it reads now).
		const input = JSON.stringify(readStoredInput(def, draft.edited_input ?? draft.input));
		if ((await passedCheck())({ ...draft, status: 'pending', input, edited_input: null }))
			throw new FamosError('conflict', 'Draft is expired');
		const id = ids.next('draft');
		await unitOfWork(actor, async (uow) => {
			const now = clock.now();
			await uow.db
				.withTables<CoreTables>()
				.insertInto('core_drafts')
				.values({
					id,
					action_id: draft.action_id,
					input,
					edited_input: null,
					status: 'pending',
					proposed_by: draft.proposed_by,
					source_kind: draft.source_kind,
					source_id: draft.source_id,
					summary: draft.summary,
					model: draft.model,
					prompt_version: draft.prompt_version,
					confidence: draft.confidence,
					uncertain_fields: draft.uncertain_fields,
					dedupe_key: dedupeKey,
					decided_by: null,
					decided_at: null,
					applied_at: null,
					result: null,
					error: null,
					for_member: draft.for_member,
					created_at: now,
					updated_at: now,
				})
				.execute();
			await audit(uow, draft.action_id, 'drafted', id, draftTargetOf(draft));
			uow.emit(draftCreated, {
				draftId: id,
				actionId: draft.action_id,
				proposerKind: (JSON.parse(draft.proposed_by) as Actor).kind,
				proposerMemberId: actor.memberId,
				sourceKind: draft.source_kind,
				forMember: draft.for_member,
			});
			// A draft addressed to one member is theirs to decide; the others are told it waits.
			if (draft.for_member !== null) return;
			const who = await proposerLabel(uow, actor);
			await uow.notify(
				waitingNotice(
					{
						id,
						summary: draft.summary,
						sourceKind: draft.source_kind,
						sourceId: draft.source_id,
						input,
					},
					def,
					actor.memberId,
					deps.draftNotifyDelayMs ?? DEFAULT_DRAFT_NOTIFY_DELAY_MS,
					who,
				),
			);
		});
		return getDraft(deps.db, id);
	}

	return { undoStep, undoDraft, suggestedAgain, suggestAgain };
}
