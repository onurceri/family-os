/** The facts of a treatment a row shows. */
export interface TreatmentFacts {
	product?: string | null;
	givenOn?: string | null;
	vet?: string | null;
}

/**
 * What a treatment row says, for a saved one and for one still waiting for approval alike, so
 * two waiting vaccinations can be told apart by their day, product and vet: the product (else the
 * kind) as the title, then the kind when a product is the title, the day and the vet.
 */
export function treatmentLines(
	facts: TreatmentFacts,
	kindLabel: string,
	dateOf: (day: string) => string,
): { title: string; parts: string[] } {
	const product = facts.product?.trim();
	return {
		title: product || kindLabel,
		parts: [
			product ? kindLabel : '',
			facts.givenOn ? dateOf(facts.givenOn) : '',
			facts.vet?.trim() ?? '',
		].filter(Boolean),
	};
}
