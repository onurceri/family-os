import type { MemberNote } from '@famos/ui/slots';

/**
 * The words about each person that `memberStatus` facets give ("Home", "At School"), as one
 * short note per person. Pure, so the shell's rules are tested without a browser.
 */

/** A note stands beside a name: longer ones are cut. */
export const MAX_NOTE = 40;

/**
 * One note per person of `members`: each facet's first note about them, in the facets' order,
 * side by side. A person no facet says anything about, or someone who is not a member shown
 * here, has no note.
 */
export function mergeMemberNotes(
	lists: readonly (readonly MemberNote[])[],
	members: readonly string[],
): Record<string, string> {
	const shown = new Set(members);
	const parts = new Map<string, string[]>();
	for (const list of lists) {
		const said = new Set<string>();
		for (const note of list) {
			const text = note.text.trim();
			if (!text || !shown.has(note.memberId) || said.has(note.memberId)) continue;
			said.add(note.memberId);
			parts.set(note.memberId, [...(parts.get(note.memberId) ?? []), text]);
		}
	}
	const notes: Record<string, string> = {};
	for (const [memberId, texts] of parts) {
		const text = texts.join(' · ');
		notes[memberId] = text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1).trimEnd()}…` : text;
	}
	return notes;
}

/** How often to read the notes again while Today is open: the most often any facet asks. */
export function notesRefreshMs(facets: readonly { refreshMs?: number }[]): number | null {
	const asked = facets
		.map((f) => f.refreshMs)
		.filter((ms): ms is number => typeof ms === 'number' && ms > 0);
	return asked.length > 0 ? Math.max(15_000, Math.min(...asked)) : null;
}
