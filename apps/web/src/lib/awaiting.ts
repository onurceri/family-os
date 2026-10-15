import { proposedByMember } from '@famos/ui/slots';

/** What the shell needs of a waiting suggestion to mark what it is about. */
export interface WaitingDraft {
	status: string;
	input?: unknown;
	editedInput?: unknown;
	proposedBy?: unknown;
	canDecide: boolean;
}

/** An input field that holds the id of a record: `id`, or a name that ends in `Id` (`petId`). */
const ID_FIELD = /^(id|[a-z][a-zA-Z0-9]*Id)$/;

/**
 * The ids of the things the member's own changes wait on someone else to approve: the record a
 * change, a removal or a new entry (a treatment of a pet) is about, read from the fields of the
 * suggestion that hold an id. Lists of ids (the people of an event) are not what it is about.
 */
export function awaitedIds(
	drafts: readonly WaitingDraft[],
	memberId: string | undefined,
): Set<string> {
	const ids = new Set<string>();
	if (!memberId) return ids;
	for (const draft of drafts) {
		if (draft.status !== 'pending' && draft.status !== 'failed') continue;
		if (draft.canDecide || !proposedByMember(draft.proposedBy, memberId)) continue;
		const input = draft.editedInput ?? draft.input;
		if (typeof input !== 'object' || input === null) continue;
		for (const [key, value] of Object.entries(input))
			if (ID_FIELD.test(key) && typeof value === 'string' && value) ids.add(value);
	}
	return ids;
}
