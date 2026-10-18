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
