import {
	type Actor,
	type AnyActionDefinition,
	type DbExecutor,
	FamosError,
	isFamosError,
	memberBehind,
	personPresent,
	principalOf,
	selfOf,
} from '@famos/sdk';
import { refusalError } from '../decide.ts';
import { ownerOf } from '../features.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { Admission } from './admission.ts';
import type { ActionRunnerDeps, DeciderFacts, DraftUnavailable } from './types.ts';

/** Who sees a draft, who may decide it, and whether its action is there to decide it at all. */
export function createDeciders(deps: ActionRunnerDeps, { can, authorize }: Admission) {
	const { registry } = deps;
	const getDraft = async (db: DbExecutor, id: string) => {
		const row = await db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', `Unknown draft "${id}"`);
		return row;
	};

	/**
	 * A draft addressed to a member is theirs alone to see and decide; anyone else does not even
	 * learn it exists. Checked before anything else, replays included.
	 */
	function assertAddressee(approver: Actor, draft: Pick<DraftRow, 'id' | 'for_member'>): void {
		if (draft.for_member !== null && selfOf(approver) !== draft.for_member)
			throw new FamosError('not_found', `Unknown draft "${draft.id}"`);
	}

	/**
	 * Deciding a draft needs `core.drafts.approve` and whatever would have let the approver make
	 * the change directly.
	 */
	function assertApprover(
		approver: Actor,
		def: AnyActionDefinition,
		draft: Pick<DraftRow, 'id' | 'for_member'>,
	): string {
		// The addressee needs no approval capability for a draft that is theirs alone.
		if (draft.for_member !== null) {
			assertAddressee(approver, draft);
		} else if (!personPresent(approver) || !can(approver, 'core.drafts.approve')) {
			throw refusalError({ reason: 'capability', capability: 'core.drafts.approve' });
		}
		// Only a person present decides a suggestion, addressee or not.
		if (!personPresent(approver))
			throw refusalError({ reason: 'capability', capability: 'core.drafts.approve' });
		authorize(def, approver);
		if (typeof def.approval === 'object' && !can(approver, def.approval.unless)) {
			throw refusalError({ reason: 'capability', capability: def.approval.unless });
		}
		return approver.memberId;
	}

	function unavailable(draft: Pick<DraftRow, 'action_id'>): DraftUnavailable | null {
		const extension = ownerOf(draft.action_id);
		if (!registry.actions.has(draft.action_id)) return { reason: 'not_installed', extension };
		return deps.features.isOn(extension) ? null : { reason: 'turned_off', extension };
	}

	function mayDecide(draft: DeciderFacts, actor: Actor): boolean {
		const def = registry.actions.get(draft.action_id);
		if (!def || unavailable(draft)) return false;
		try {
			assertApprover(actor, def, draft);
			return true;
		} catch (error) {
			if (isFamosError(error)) return false;
			throw error;
		}
	}

	function draftVisibleTo(actor: Actor, draft: DraftRow): boolean {
		const member = memberBehind(actor);
		if (draft.for_member !== null && draft.for_member !== member) return false;
		if (actor.kind === 'member') {
			const { via: _via, ...person } = actor;
			return (
				mayDecide(draft, person) ||
				isProposer(person, draft) ||
				(unavailable(draft) !== null && can(person, 'core.drafts.approve'))
			);
		}
		return principalOf(JSON.parse(draft.proposed_by) as Actor) === principalOf(actor);
	}

	/** The member behind a draft: who proposed it, or who the AI proposed it for. */
	function proposerOf(draft: DraftRow): string | null {
		return memberBehind(JSON.parse(draft.proposed_by) as Actor);
	}

	/** Whether this actor is the member behind the draft (they may take their own suggestion back). */
	function isProposer(actor: Actor, draft: DraftRow): boolean {
		const self = selfOf(actor);
		return self !== null && proposerOf(draft) === self;
	}

	return {
		getDraft,
		assertAddressee,
		assertApprover,
		unavailable,
		mayDecide,
		draftVisibleTo,
		proposerOf,
		isProposer,
	};
}

export type Deciders = ReturnType<typeof createDeciders>;
