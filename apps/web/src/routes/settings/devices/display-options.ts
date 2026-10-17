/**
 * What "Add a screen" and a screen's panel offer a display, as plain data so it is tested without
 * a browser.
 */

/** A web contribution, as far as a display's permissions are concerned. */
export interface DisplayContribution {
	slot: string;
	requires?: string;
}

/** The slots a display renders, and so the permissions they need are worth offering. */
const DISPLAY_SLOTS = new Set(['display.widget', 'display.status', 'display.ambient']);

/**
 * The permissions a display can use (`offered`), and those a new screen starts without
 * (`optIn`): a permission only a status pill needs. A pill sits in the clock row and tells
 * passers-by about the household's waiting work rather than the day, so it is the admin's choice
 * to add, like names and colours; everything that makes up the day starts ticked.
 */
export function displayOptions(
	familyMode: readonly string[],
	contributions: readonly DisplayContribution[],
): { offered: Set<string>; optIn: Set<string> } {
	const shown = contributions.filter((c) => DISPLAY_SLOTS.has(c.slot) && c.requires);
	const forTheDay = new Set([
		...familyMode,
		...shown.flatMap((c) => (c.slot === 'display.status' ? [] : [c.requires as string])),
	]);
	const offered = new Set([...forTheDay, ...shown.map((c) => c.requires as string)]);
	return { offered, optIn: new Set([...offered].filter((id) => !forTheDay.has(id))) };
}

/** What a new screen starts with: every offered permission but the opt-in ones. */
export function initialGrant(
	options: readonly { id: string }[],
	optIn: ReadonlySet<string>,
): string[] {
	return options.map((o) => o.id).filter((id) => !optIn.has(id));
}
