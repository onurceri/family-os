/** The edits a person made to suggestions in a group, by draft id (the edited input). */
export type Edits = ReadonlyMap<string, unknown>;

/** The edits with one draft's changed; `undefined` takes the edit back. */
export function withEdit(edits: Edits, id: string, input: unknown): Edits {
	const next = new Map(edits);
	if (input === undefined) next.delete(id);
	else next.set(id, input);
	return next;
}

/**
 * The ticks after a card's edit is saved: saving an edit is the decision to add it, so the card
 * is ticked (also when it started unticked, as a suggestion that may already exist does); taking
 * the edit back leaves the ticks alone.
 */
export function choicesAfterEdit(
	choices: ReadonlyMap<string, boolean>,
	id: string,
	input: unknown,
): ReadonlyMap<string, boolean> {
	return input === undefined ? choices : new Map(choices).set(id, true);
}

/**
 * What to approve, in order: each ticked suggestion with its edited input when it has one, so
 * "Add selected" adds what the card shows and not what was first proposed.
 */
export function approvals(
	picked: readonly { id: string }[],
	edits: Edits,
): { id: string; input?: unknown }[] {
	return picked.map(({ id }) => (edits.has(id) ? { id, input: edits.get(id) } : { id }));
}
