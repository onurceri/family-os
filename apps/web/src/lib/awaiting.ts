import type { AwaitedChange } from '@famos/ui/app';
import { proposedByMember } from '@famos/ui/slots';

/** What the shell needs of a waiting suggestion to mark what it is about and what it changes. */
export interface WaitingDraft {
	actionId: string;
	status: string;
	input?: unknown;
	editedInput?: unknown;
	proposedBy?: unknown;
	/** What the fields it changes hold now, keyed like its input (null when not known). */
	before?: Readonly<Record<string, unknown>> | null;
	canDecide: boolean;
}

/** An input field that holds the id of a record: `id`, or a name that ends in `Id` (`petId`). */
const ID_FIELD = /^(id|[a-z][a-zA-Z0-9]*Id)$/;

/**
 * The things the member's own changes wait on someone else to approve, each with the change that
 * waits: the record a change, a removal or a new entry (a treatment of a pet) is about, read from
 * the fields of the suggestion that hold an id. Lists of ids (the people of an event) are not what
 * it is about. With several waiting changes to one thing, the first given (the newest) is kept.
 */
export function awaitedChanges(
	drafts: readonly WaitingDraft[],
	memberId: string | undefined,
): Map<string, AwaitedChange> {
	const changes = new Map<string, AwaitedChange>();
	if (!memberId) return changes;
	for (const draft of drafts) {
		if (draft.status !== 'pending' && draft.status !== 'failed') continue;
		if (draft.canDecide || !proposedByMember(draft.proposedBy, memberId)) continue;
		const input = draft.editedInput ?? draft.input;
		if (typeof input !== 'object' || input === null) continue;
		const change: AwaitedChange = { actionId: draft.actionId, input, before: draft.before ?? null };
		for (const [key, value] of Object.entries(input))
			if (ID_FIELD.test(key) && typeof value === 'string' && value && !changes.has(value))
				changes.set(value, change);
	}
	return changes;
}
