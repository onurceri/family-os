/**
 * What a draft is called where its presenter does not title it (a remove or archive nobody wrote
 * a presenter for, a draft made by hand): its summary, else the action's own translated name
 * with the review label of the thing it is about, else the action id as a last resort.
 */
export function draftHeadline(draft: {
	summary: string | null;
	titleKey: string | null;
	actionId: string;
	input: unknown;
	t: (key: string) => string;
}): string {
	if (draft.summary) return draft.summary;
	if (!draft.titleKey) return draft.actionId;
	const name = draft.t(draft.titleKey);
	const label =
		typeof draft.input === 'object' && draft.input !== null && 'label' in draft.input
			? draft.input.label
			: undefined;
	return typeof label === 'string' && label.trim() ? `${name} · ${label.trim()}` : name;
}

/** Whether the signed-in member is the one behind a draft, so they may withdraw it. */
export function proposedByMember(proposedBy: unknown, memberId: string | undefined): boolean {
	if (!memberId || typeof proposedBy !== 'object' || proposedBy === null) return false;
	const by = proposedBy as { kind?: string; memberId?: string; onBehalfOf?: string };
	return by.kind === 'member' ? by.memberId === memberId : by.onBehalfOf === memberId;
}
