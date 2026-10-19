/** The facts of a service or repair entry a row shows. */
export interface LogFacts {
	doneOn?: string | null;
	place?: string | null;
	notes?: string | null;
}

/**
 * What an entry row says, for a saved one and for one still waiting for approval alike: the kind
 * and day as the title, then the place and the notes.
 */
export function logLines(
	facts: LogFacts,
	kindLabel: string,
	dateOf: (day: string) => string,
): { title: string; parts: string[] } {
	return {
		title: facts.doneOn ? `${kindLabel} · ${dateOf(facts.doneOn)}` : kindLabel,
		parts: [facts.place?.trim() ?? '', facts.notes?.trim() ?? ''].filter(Boolean),
	};
}
