import type { AwaitedChange } from '@famos/ui/app';
import { memberBehindDraft } from '@famos/ui/slots';

/** What the shell needs of a waiting suggestion to mark what it is about and what it changes. */
export interface WaitingDraft {
	id?: string;
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
 * The changes that wait for someone's approval and concern the signed-in member, newest first
 * as given: their own that someone else decides, and another person's that they may decide
 * (`by` names that person). What the member asked for and decides themselves (their own Quick add
 * suggestions) is not waiting on anyone, and so is left out.
 */
export function waitingChanges(
	drafts: readonly WaitingDraft[],
	memberId: string | undefined,
): AwaitedChange[] {
	if (!memberId) return [];
	const changes: AwaitedChange[] = [];
	for (const draft of drafts) {
		if (draft.status !== 'pending' && draft.status !== 'failed') continue;
		const proposer = memberBehindDraft(draft.proposedBy);
		const own = proposer === memberId;
		if (own ? draft.canDecide : !draft.canDecide || proposer === undefined) continue;
		const input = draft.editedInput ?? draft.input;
		if (typeof input !== 'object' || input === null) continue;
		changes.push({
			...(draft.id ? { draftId: draft.id } : {}),
			actionId: draft.actionId,
			input,
			before: draft.before ?? null,
			...(own ? {} : { by: proposer }),
		});
	}
	return changes;
}

/** The ids of records a change's input names (lists of ids, the people of an event, are not). */
function idsOf(input: unknown): string[] {
	if (typeof input !== 'object' || input === null) return [];
	return Object.entries(input).flatMap(([key, value]) =>
		ID_FIELD.test(key) && typeof value === 'string' && value ? [value] : [],
	);
}

/**
 * The things waiting changes are about, each with the change that waits: the record a change, a
 * removal or a new entry (a treatment of a pet) is about, read from the fields of the suggestion
 * that hold an id. With several waiting changes to one thing, the first given (the newest) is kept.
 */
export function awaitedChanges(
	drafts: readonly WaitingDraft[],
	memberId: string | undefined,
): Map<string, AwaitedChange> {
	return changesById(waitingChanges(drafts, memberId));
}

export function changesById(changes: readonly AwaitedChange[]): Map<string, AwaitedChange> {
	const byId = new Map<string, AwaitedChange>();
	for (const change of changes)
		for (const id of idsOf(change.input)) if (!byId.has(id)) byId.set(id, change);
	return byId;
}

/**
 * The waiting changes that would add something new: those of the given actions, and with `aboutId`
 * only those whose input names it (the treatments of one pet), oldest first, so a list shows them
 * in the order they were asked for.
 */
export function awaitedNew(
	changes: readonly AwaitedChange[],
	actionIds: readonly string[],
	aboutId?: string,
): AwaitedChange[] {
	return changes
		.filter(
			(change) =>
				actionIds.includes(change.actionId) &&
				(aboutId === undefined || idsOf(change.input).includes(aboutId)),
		)
		.toReversed();
}
