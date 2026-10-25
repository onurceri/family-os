import {
	type Actor,
	type AnyActionDefinition,
	FamosError,
	selfOf,
	type UnitOfWork,
} from '@famos/sdk';
import { recordChanges } from '../changes.ts';
import { draftUpdated, notificationRead } from '../core-events.ts';
import { refusalError } from '../decide.ts';
import { settleWaitingNotices } from '../draft-notices.ts';
import { familyReader } from '../family.ts';
import { ownerOf } from '../features.ts';
import { readStoredInput } from '../stored-input.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { Admission } from './admission.ts';
import { NESTED_NEEDS_APPROVAL, parseOrThrow } from './shared.ts';
import type { ActionRunnerDeps } from './types.ts';

/**
 * The transaction every change runs in (with the actions an action runs inside it), the audit
 * log, and applying an action's run.
 */
export function createUnitOfWork(
	deps: ActionRunnerDeps,
	{ can, getAction, assertCallable, authorize, governedByOwner, decideInput }: Admission,
) {
	const { registry, bus, clock, ids, logger } = deps;
	/** A decided suggestion no longer waits: its unread "waiting" notices are marked read. */
	async function settleNotices(
		uow: UnitOfWork,
		draft: { id: string; source_kind: string | null; source_id: string | null },
	): Promise<void> {
		for (const memberId of await settleWaitingNotices(uow.db, draft))
			uow.emit(notificationRead, { memberId });
	}

	/**
	 * Runs `work` in one transaction; events and job wake-ups fire only after commit. `work` gets
	 * the host's unit of work (core's bookkeeping: drafts, audit) and `view`, which gives an
	 * extension's action its own view of the same transaction.
	 */
	async function unitOfWork<T>(
		actor: Actor,
		work: (uow: UnitOfWork, view: (extensionId: string) => UnitOfWork) => Promise<T>,
		/**
		 * `decided`: a person already approved what this unit of work does (an approved suggestion
		 * is applied, or taken back), so an action it runs inside needs no approval of its own.
		 */
		{ decided = false, proposer = actor }: { decided?: boolean; proposer?: Actor } = {},
	): Promise<T> {
		const events: [string, unknown][] = [];
		let enqueued = 0;
		const result = await deps.db.transaction().execute(async (trx) => {
			const enqueue: UnitOfWork['enqueue'] = async (job, payload, options) => {
				const def = registry.jobs.get(job);
				if (!def) throw new Error(`Unknown job "${job}"`);
				enqueued++;
				return deps.queue.enqueue(trx, job, def.payload.parse(payload), {
					maxAttempts: def.maxAttempts,
					...options,
				});
			};
			const views = new Map<string, UnitOfWork>();
			const view = (owner: string): UnitOfWork => {
				const known = views.get(owner);
				if (known) return known;
				const made = makeView(owner);
				views.set(owner, made);
				return made;
			};
			const makeView = (owner: string): UnitOfWork => ({
				db: deps.views.db(owner, trx),
				actor,
				proposer,
				clock,
				ids,
				logger,
				files: deps.views.files(owner, trx),
				secrets: deps.views.secrets(owner),
				family: familyReader(trx),
				translate: deps.translate,
				vocabulary: deps.vocabulary,
				ai: deps.indexer(enqueue, trx),
				can: (capability) => can(actor, capability),
				proposerCan: (capability) => can(proposer, capability),
				emit(event, payload) {
					events.push([event.name, event.payload.parse(payload)]);
				},
				enqueue,
				async notify(request) {
					enqueued++;
					await deps.notifier.enqueue(trx, request);
				},
				async rejectDraftsOf(source) {
					const waiting = await trx
						.withTables<CoreTables>()
						.selectFrom('core_drafts')
						.select([
							'id',
							'action_id',
							'input',
							'edited_input',
							'source_kind',
							'source_id',
							'for_member',
						])
						.where('source_kind', '=', source.kind)
						.where('source_id', '=', source.id)
						.where('status', 'in', ['pending', 'failed'])
						.execute();
					const now = clock.now();
					for (const draft of waiting) {
						await trx
							.withTables<CoreTables>()
							.updateTable('core_drafts')
							.set({
								status: 'rejected',
								decided_by: selfOf(actor),
								decided_at: now,
								updated_at: now,
							})
							.where('id', '=', draft.id)
							.execute();
						await audit(view('core'), draft.action_id, 'rejected', draft.id, draftTargetOf(draft));
						view('core').emit(draftUpdated, {
							draftId: draft.id,
							status: 'rejected',
							forMember: draft.for_member,
						});
					}
					if (waiting[0]) await settleNotices(view('core'), waiting[0]);
					return waiting.length;
				},
				async run(actionId, input) {
					const def = getAction(actionId);
					assertCallable(owner, def, actor);
					authorize(def, actor);
					const parsed = parseOrThrow(def.input, input, `input for ${actionId}`);
					// An action run inside another is decided like any call: what would need a
					// suggestion for this actor is refused, never applied directly, so the outer
					// action is the one that carries the approval.
					if (!decided && !(await governedByOwner(def, owner, parsed, trx))) {
						const decision = await decideInput(def, actor, parsed, null, trx);
						if (decision.outcome === 'refuse') throw refusalError(decision);
						if (decision.outcome === 'draft')
							throw new FamosError(
								'forbidden',
								'This needs approval, so it cannot be done as part of another action',
								{
									reason: NESTED_NEEDS_APPROVAL,
									...(decision.capability && { capability: decision.capability }),
								},
							);
					}
					return def.run(view(ownerOf(def.id)), parsed);
				},
			});
			const done = await work(view('core'), view);
			// Written in the transaction of the change: a rollback leaves no trace, a commit all of it.
			await recordChanges(trx, registry.events, clock.now(), events);
			return done;
		});
		if (enqueued > 0) deps.onJobsEnqueued?.();
		for (const [name, payload] of events) await bus.publish(name, payload);
		return result;
	}

	async function audit(
		uow: UnitOfWork,
		actionId: string,
		outcome: 'applied' | 'drafted' | 'rejected' | 'undone' | 'replaced',
		draftId: string | null,
		target: string | null,
	) {
		await uow.db
			.withTables<CoreTables>()
			.insertInto('core_audit_log')
			.values({
				at: clock.now(),
				actor: JSON.stringify(uow.actor),
				action_id: actionId,
				draft_id: draftId,
				outcome,
				target,
			})
			.execute();
	}

	/**
	 * The id of the row an input works on (the action's `target`), which the audit row names; null
	 * for an action without one or an input that names none. Only the id: never the input itself.
	 */
	function targetIdOf(def: AnyActionDefinition | undefined, input: unknown): string | null {
		if (!def?.target) return null;
		try {
			return def.target(input)?.id ?? null;
		} catch {
			return null;
		}
	}

	/** The target of a stored draft, read as its action reads the input today. */
	function draftTargetOf(
		draft: Pick<DraftRow, 'action_id' | 'input' | 'edited_input'>,
	): string | null {
		const def = registry.actions.get(draft.action_id);
		if (!def?.target) return null;
		try {
			const input = def.input.safeParse(readStoredInput(def, draft.edited_input ?? draft.input));
			return input.success ? targetIdOf(def, input.data) : null;
		} catch {
			// An input stored by another version may not fit today's shape: the row names nothing.
			return null;
		}
	}

	async function apply(
		uow: UnitOfWork,
		view: (extensionId: string) => UnitOfWork,
		def: AnyActionDefinition,
		input: unknown,
		draftId: string | null,
		prepared?: unknown,
	) {
		const output = parseOrThrow(
			def.output,
			await def.run(view(ownerOf(def.id)), input, prepared),
			`output of ${def.id}`,
		);
		if (!def.readOnly) await audit(uow, def.id, 'applied', draftId, targetIdOf(def, input));
		return output;
	}

	return { settleNotices, unitOfWork, audit, targetIdOf, draftTargetOf, apply };
}

export type UnitOfWorkParts = ReturnType<typeof createUnitOfWork>;
