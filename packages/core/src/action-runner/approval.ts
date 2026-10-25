import {
	type Actor,
	FamosError,
	isFamosError,
	personPresent,
	systemActor,
	type UnitOfWork,
} from '@famos/sdk';
import { draftUpdated } from '../core-events.ts';
import { refusalError } from '../decide.ts';
import { ownerOf } from '../features.ts';
import { readStoredInput } from '../stored-input.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { Admission } from './admission.ts';
import type { Deciders } from './deciders.ts';
import type { Hints } from './hints.ts';
import type { Labels } from './labels.ts';
import { DECIDED, fieldOf, GONE, parseOrThrow, SETTLED, sameValue } from './shared.ts';
import type { ActionRunnerDeps } from './types.ts';
import type { UnitOfWorkParts } from './unit-of-work.ts';
import type { Waiting } from './waiting.ts';

/** Deciding a waiting suggestion: editing it, approving, rejecting or replacing it. */
export function createApproval(
	deps: ActionRunnerDeps,
	{
		can,
		getAction,
		getDraft,
		assertAddressee,
		assertApprover,
		unavailable,
		mayDecide,
		isProposer,
		unitOfWork,
		settleNotices,
		audit,
		draftTargetOf,
		apply,
		passedCheck,
		alternative,
		decidedNotice,
	}: Admission & Deciders & UnitOfWorkParts & Waiting & Hints & Labels,
) {
	const { registry, clock, logger } = deps;
	async function editDraft(uow: UnitOfWork, draftId: string, input: unknown): Promise<DraftRow> {
		const actor = uow.actor;
		const draft = await getDraft(uow.db, draftId);
		assertAddressee(actor, draft);
		if (!personPresent(actor))
			throw new FamosError('forbidden', 'Only a person edits a suggestion');
		const waits = unavailable(draft) !== null;
		const allowed =
			isProposer(actor, draft) ||
			mayDecide(draft, actor) ||
			(waits && can(actor, 'core.drafts.approve'));
		if (!allowed) throw refusalError({ reason: 'capability', capability: 'core.drafts.approve' });
		if (draft.status !== 'pending')
			throw new FamosError('conflict', `Draft is ${draft.status}; only a waiting one is edited`);
		if (waits)
			throw new FamosError(
				'conflict',
				'This suggestion waits until its extension is back, so it cannot be edited now',
			);
		const def = getAction(draft.action_id);
		const parsed = parseOrThrow(def.input, input, `input for ${def.id}`);
		// A field a person changed is no longer a guess: they looked at it. Marks on the fields
		// they left alone stay.
		const before = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
		const marks: string[] = draft.uncertain_fields ? JSON.parse(draft.uncertain_fields) : [];
		const kept = marks.filter(
			(mark) => !before.success || sameValue(fieldOf(before.data, mark), fieldOf(parsed, mark)),
		);
		await uow.db
			.withTables<CoreTables>()
			.updateTable('core_drafts')
			.set({
				edited_input: JSON.stringify(parsed),
				uncertain_fields: kept.length > 0 ? JSON.stringify(kept) : null,
				updated_at: uow.clock.now(),
			})
			.where('id', '=', draftId)
			.where('status', '=', 'pending')
			.execute();
		uow.emit(draftUpdated, { draftId, status: 'pending', forMember: draft.for_member });
		return getDraft(uow.db, draftId);
	}

	async function approveDraft(
		draftId: string,
		approver: Actor,
		editedInput?: unknown,
		options: { auto?: boolean } = {},
	): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(approver, draft);
		if (draft.status === 'applied') return draft; // idempotent
		// What was taken back stays taken back: the person behind it may send it again as a new
		// suggestion, which is decided like any other.
		if (draft.status === 'undone')
			throw new FamosError(
				'conflict',
				'Draft is undone, so it cannot be approved again. The person who suggested it can suggest it again (core.suggestDraftAgain), and that new suggestion is approved as usual.',
				{ status: 'undone', next: 'core.suggestDraftAgain' },
			);
		if (draft.status !== 'pending' && draft.status !== 'failed') {
			throw new FamosError('conflict', `Draft is ${draft.status}`);
		}
		const def = getAction(draft.action_id);
		const approverId = assertApprover(approver, def, draft);
		const input = parseOrThrow(
			def.input,
			editedInput ?? readStoredInput(def, draft.edited_input ?? draft.input),
			`input for ${def.id}`,
		);
		// A suggestion about a day that has passed never runs (unless an edit moved it on).
		if ((await passedCheck())({ ...draft, edited_input: JSON.stringify(input) }))
			throw new FamosError('conflict', 'Draft is expired');
		// What the household's own setting approved is no news to the person behind it.
		const told = options.auto ? null : await decidedNotice(draft, def, approverId, 'approved');

		try {
			await unitOfWork(
				approver,
				async (uow, view) => {
					const now = clock.now();
					const claimed = await uow.db
						.withTables<CoreTables>()
						.updateTable('core_drafts')
						.set({
							status: 'approved',
							decided_by: approverId,
							decided_at: now,
							updated_at: now,
							...(options.auto && { auto_approved: 1 }),
						})
						.where('id', '=', draftId)
						.where('status', 'in', ['pending', 'failed'])
						.executeTakeFirst();
					if (Number(claimed.numUpdatedRows) === 0)
						throw new FamosError('conflict', 'Draft was decided concurrently');

					// Already so (ticked, done): running it changes nothing, and recording it as
					// applied would offer an undo that reverses somebody else's real change.
					if (
						def.settled &&
						(await def.settled(
							{
								db: view(ownerOf(def.id)).db,
								family: uow.family,
								translate: deps.translate,
								vocabulary: deps.vocabulary,
								now: clock.now(),
							},
							input,
						))
					) {
						await uow.db
							.withTables<CoreTables>()
							.updateTable('core_drafts')
							.set({ status: 'rejected', error: SETTLED, updated_at: clock.now() })
							.where('id', '=', draftId)
							.execute();
						await audit(uow, draft.action_id, 'rejected', draftId, draftTargetOf(draft));
						uow.emit(draftUpdated, { draftId, status: 'rejected', forMember: draft.for_member });
						await settleNotices(uow, draft);
						return;
					}

					const output = await apply(uow, view, def, input, draftId);
					await uow.db
						.withTables<CoreTables>()
						.updateTable('core_drafts')
						.set({
							status: 'applied',
							applied_at: clock.now(),
							// A saved edit stays; an edit sent with the approval replaces it.
							...(editedInput !== undefined && { edited_input: JSON.stringify(input) }),
							result: JSON.stringify(output ?? null),
							error: null,
							updated_at: clock.now(),
						})
						.where('id', '=', draftId)
						.execute();
					uow.emit(draftUpdated, { draftId, status: 'applied', forMember: draft.for_member });
					await settleNotices(uow, draft);
					if (told) await uow.notify(told);
				},
				{ ...DECIDED, proposer: JSON.parse(draft.proposed_by) as Actor },
			);
		} catch (error) {
			// What it is about is gone: the draft can never be applied, so it leaves the queue
			// (a retry would only fail again) and says why.
			if (isFamosError(error) && error.code === 'not_found')
				return closeAsGone(draft, approver, approverId);
			// Domain errors (validation, permissions, conflicts) leave the draft untouched.
			if (isFamosError(error)) throw error;
			logger.error({ err: error, draftId }, 'applying draft failed');
			// Its own unit of work: the apply was rolled back, and the new state of the draft reaches
			// the change log with the write.
			await unitOfWork(systemActor('core'), async (uow) => {
				const failed = await uow.db
					.withTables<CoreTables>()
					.updateTable('core_drafts')
					.set({
						status: 'failed',
						error: error instanceof Error ? error.message : String(error),
						updated_at: clock.now(),
					})
					.where('id', '=', draftId)
					.where('status', 'in', ['pending', 'failed'])
					.executeTakeFirst();
				// Somebody decided it meanwhile: their decision stands.
				if (Number(failed.numUpdatedRows) === 0) return;
				uow.emit(draftUpdated, { draftId, status: 'failed', forMember: draft.for_member });
			});
			throw new FamosError('unavailable', 'Applying the draft failed; it can be retried');
		}
		return getDraft(deps.db, draftId);
	}

	/** Closes a waiting draft whose subject no longer exists; the reason is `error: 'gone'`. */
	async function closeAsGone(
		draft: DraftRow,
		approver: Actor,
		decidedBy: string,
	): Promise<DraftRow> {
		await unitOfWork(approver, async (uow) => {
			const now = clock.now();
			const closed = await uow.db
				.withTables<CoreTables>()
				.updateTable('core_drafts')
				.set({
					status: 'rejected',
					decided_by: decidedBy,
					decided_at: now,
					error: GONE,
					updated_at: now,
				})
				.where('id', '=', draft.id)
				.where('status', 'in', ['pending', 'failed'])
				.executeTakeFirst();
			if (Number(closed.numUpdatedRows) === 0) return;
			await audit(uow, draft.action_id, 'rejected', draft.id, draftTargetOf(draft));
			uow.emit(draftUpdated, {
				draftId: draft.id,
				status: 'rejected',
				forMember: draft.for_member,
			});
			await settleNotices(uow, draft);
		});
		return getDraft(deps.db, draft.id);
	}

	/**
	 * Rejecting needs the same standing as approving; the member behind a draft may always take
	 * their own back (withdraw it), even without `core.drafts.approve`.
	 */
	async function rejectDraft(draftId: string, approver: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(approver, draft);
		if (draft.status === 'rejected') return draft;
		if (draft.status !== 'pending' && draft.status !== 'failed')
			throw new FamosError('conflict', `Draft is ${draft.status}`);
		const approverId =
			isProposer(approver, draft) && personPresent(approver)
				? approver.memberId
				: assertApprover(approver, getAction(draft.action_id), draft);
		const def = registry.actions.get(draft.action_id);
		const told = def ? await decidedNotice(draft, def, approverId, 'rejected') : null;
		await unitOfWork(approver, async (uow) => {
			const now = clock.now();
			// Decided here, not on the earlier read: an approval may have committed in between.
			const claimed = await uow.db
				.withTables<CoreTables>()
				.updateTable('core_drafts')
				.set({ status: 'rejected', decided_by: approverId, decided_at: now, updated_at: now })
				.where('id', '=', draftId)
				.where('status', 'in', ['pending', 'failed'])
				.executeTakeFirst();
			if (Number(claimed.numUpdatedRows) === 0) {
				const current = await getDraft(uow.db, draftId);
				if (current.status === 'rejected') return; // idempotent
				throw new FamosError('conflict', `Draft is ${current.status}`);
			}
			await audit(uow, draft.action_id, 'rejected', draftId, draftTargetOf(draft));
			uow.emit(draftUpdated, { draftId, status: 'rejected', forMember: draft.for_member });
			await settleNotices(uow, draft);
			if (told) await uow.notify(told);
		});
		return getDraft(deps.db, draftId);
	}

	async function replaceDraft(draftId: string, actor: Actor): Promise<DraftRow> {
		const draft = await getDraft(deps.db, draftId);
		assertAddressee(actor, draft);
		if (draft.status !== 'pending') throw new FamosError('conflict', `Draft is ${draft.status}`);
		// Choosing the alternative is a decision about the draft as it was proposed.
		assertApprover(actor, getAction(draft.action_id), draft);
		if (draft.replaced !== null) return draft; // idempotent
		// Worked out again here: what a client sends is never the alternative.
		const offered = await alternative(draft);
		if (!offered) throw new FamosError('conflict', 'There is nothing to do instead');
		const next = getAction(offered.actionId);
		// And about the change it becomes: nobody turns a draft into one they could not approve.
		assertApprover(actor, next, draft);
		const input = JSON.stringify(offered.input);
		if ((await passedCheck())({ ...draft, action_id: next.id, input, edited_input: null }))
			throw new FamosError('conflict', 'Draft is expired');
		await unitOfWork(actor, async (uow) => {
			const now = clock.now();
			const changed = await uow.db
				.withTables<CoreTables>()
				.updateTable('core_drafts')
				.set({
					action_id: next.id,
					input,
					edited_input: null,
					replaced: JSON.stringify({ actionId: draft.action_id, input: JSON.parse(draft.input) }),
					updated_at: now,
				})
				.where('id', '=', draftId)
				.where('status', '=', 'pending')
				.where('action_id', '=', draft.action_id)
				.executeTakeFirst();
			if (Number(changed.numUpdatedRows) === 0)
				throw new FamosError('conflict', 'Draft was decided concurrently');
			await audit(uow, draft.action_id, 'replaced', draftId, draftTargetOf(draft));
			uow.emit(draftUpdated, { draftId, status: 'pending', forMember: draft.for_member });
		});
		return getDraft(deps.db, draftId);
	}

	return { editDraft, approveDraft, rejectDraft, replaceDraft };
}
