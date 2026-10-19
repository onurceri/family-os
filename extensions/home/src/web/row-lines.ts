/** The facts of a thing of the home a row shows. */
export interface ItemFacts {
	room?: string | null;
	brand?: string | null;
	model?: string | null;
}

/** The facts of a service a row shows. */
export interface ServiceFacts {
	dueDay?: number | null;
}

/** Where a thing is and what make it is: the line under it, saved or still waiting for approval. */
export function itemLine(facts: ItemFacts): string {
	return [facts.room?.trim(), [facts.brand?.trim(), facts.model?.trim()].filter(Boolean).join(' ')]
		.filter(Boolean)
		.join(' · ');
}

/** What kind of service it is and its billing day: the line under it, saved or waiting. */
export function serviceLine(
	facts: ServiceFacts,
	kindLabel: string,
	dueDayLabel: (day: number) => string,
): string {
	return [kindLabel, facts.dueDay ? dueDayLabel(facts.dueDay) : ''].filter(Boolean).join(' · ');
}
