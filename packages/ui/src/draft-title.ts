/**
 * What a draft is called where its presenter does not title it (a remove or archive nobody wrote
 * a presenter for, a draft made by hand): its summary, else the action's own translated name
 * with the name of the thing it is about (the review label, else the subject the server read
 * from the record), else a generic word (never an action id).
 */
export function draftHeadline(draft: {
	summary: string | null;
	titleKey: string | null;
	actionId: string;
	input: unknown;
	subject?: string | null;
	t: (key: string) => string;
}): string {
	if (draft.summary) return draft.summary;
	const label =
		typeof draft.input === 'object' && draft.input !== null && 'label' in draft.input
			? draft.input.label
			: undefined;
	const named =
		typeof label === 'string' && label.trim() ? label.trim() : draft.subject?.trim() || '';
	if (!draft.titleKey) return named || draft.t('app:draft_kind_generic');
	const name = draft.t(draft.titleKey);
	return named ? `${name} · ${named}` : name;
}

/**
 * A draft's input as its card shows it: with the name of what it is about as its `label` when
 * the stored input has none (a draft stored before drafts carried it), so a presenter that titles
 * a change by its label names the thing.
 */
export function namedInput(input: unknown, subject: string | null | undefined): unknown {
	if (!subject || typeof input !== 'object' || input === null) return input;
	const label = (input as { label?: unknown }).label;
	return typeof label === 'string' && label.trim() ? input : { ...input, label: subject };
}

/** Whether the signed-in member is the one behind a draft, so they may withdraw it. */
export function proposedByMember(proposedBy: unknown, memberId: string | undefined): boolean {
	if (!memberId || typeof proposedBy !== 'object' || proposedBy === null) return false;
	const by = proposedBy as { kind?: string; memberId?: string; onBehalfOf?: string };
	return by.kind === 'member' ? by.memberId === memberId : by.onBehalfOf === memberId;
}

/**
 * The small heading above a card no presenter describes: the name of the extension the action
 * belongs to (its `nav` text, "Kitchen"), else a generic word. Never the action id.
 */
export function draftKicker(draft: { actionId: string; t: (key: string) => string }): string {
	const owner = draft.actionId.split('.')[0] ?? '';
	const key = `${owner}:nav`;
	const name = owner ? draft.t(key) : '';
	// A missing key comes back as itself or as its last part, never as a name.
	return name && name !== key && name !== 'nav' ? name : draft.t('app:draft_kind_generic');
}

/**
 * Who asked for a suggestion when it was somebody other than the signed-in member: the name of
 * the member behind it (who proposed it, or who the assistant or a shared message was for).
 * Undefined when it is the member's own, or nobody in particular is behind it.
 */
export function askedBy(
	proposedBy: unknown,
	memberId: string | undefined,
	members: readonly { id: string; displayName: string }[],
): string | undefined {
	if (typeof proposedBy !== 'object' || proposedBy === null) return undefined;
	const by = proposedBy as { kind?: string; memberId?: string; onBehalfOf?: string };
	const who = by.kind === 'member' ? by.memberId : by.onBehalfOf;
	if (!who || who === memberId) return undefined;
	return members.find((m) => m.id === who)?.displayName;
}
