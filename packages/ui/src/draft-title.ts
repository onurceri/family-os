/**
 * What a draft is called where its presenter does not title it (a remove or archive nobody wrote
 * a presenter for, a draft made by hand): the name of the thing it is about (the review label,
 * else the subject the server read from the record) with the action's own translated name, else
 * its summary, else the action's name, else a generic word (never an action id). Inside a
 * capture's group the summary is the group's own line (`groupLine`), which every card would
 * repeat, so it is left out there and the action's name stands in.
 */
export function draftHeadline(draft: {
	summary: string | null;
	titleKey: string | null;
	actionId: string;
	input: unknown;
	subject?: string | null;
	groupLine?: string | null;
	t: (key: string) => string;
}): string {
	const label =
		typeof draft.input === 'object' && draft.input !== null && 'label' in draft.input
			? draft.input.label
			: undefined;
	const named =
		typeof label === 'string' && label.trim() ? label.trim() : draft.subject?.trim() || '';
	// What it is about comes before the summary: inside a capture's group the summary is the
	// group's own line, which every card of the group would repeat.
	if (named) return draft.titleKey ? `${draft.t(draft.titleKey)} · ${named}` : named;
	const summary = draft.summary?.trim();
	const repeatsGroup =
		Boolean(summary) &&
		summary?.toLocaleLowerCase() === draft.groupLine?.trim().toLocaleLowerCase();
	if (summary && !repeatsGroup) return summary;
	return draft.titleKey ? draft.t(draft.titleKey) : draft.t('app:draft_kind_generic');
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
	return !!memberId && memberBehindDraft(proposedBy) === memberId;
}

/**
 * The member behind a draft's `proposedBy` (as the API sends it): who made it, or who the AI made
 * it for. Undefined for a display, the system, or an AI working for nobody. The one place the web
 * reads it, mirroring `memberBehind` of the SDK for data that arrives untyped.
 */
export function memberBehindDraft(proposedBy: unknown): string | undefined {
	if (typeof proposedBy !== 'object' || proposedBy === null) return undefined;
	const by = proposedBy as { kind?: string; memberId?: unknown; onBehalfOf?: unknown };
	const id = by.kind === 'member' ? by.memberId : by.kind === 'ai' ? by.onBehalfOf : undefined;
	return typeof id === 'string' && id ? id : undefined;
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
	const who = memberBehindDraft(proposedBy);
	if (!who || who === memberId) return undefined;
	return members.find((m) => m.id === who)?.displayName;
}

/** Why a waiting draft cannot be decided now (`Draft.unavailable`). */
export interface DraftUnavailable {
	reason: 'not_installed' | 'turned_off';
	extension: string;
	/** The extension's names by language, when the server knows them. */
	labels: Readonly<Record<string, string>>;
}

/**
 * What every card of a suggestion that cannot be decided says: which extension is missing or off
 * and that the suggestion waits until it is back. The name comes in the reader's language, else
 * English, else the extension's id.
 */
export function unavailableLine(
	unavailable: DraftUnavailable,
	language: string,
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	const name =
		unavailable.labels[language] ??
		unavailable.labels.en ??
		Object.values(unavailable.labels)[0] ??
		unavailable.extension;
	return t(
		unavailable.reason === 'turned_off' ? 'app:draft_turned_off' : 'app:draft_not_installed',
		{ name },
	);
}
