/**
 * The people of the style and colour previews. They are the family's own when it has them, so
 * the picture looks like home; a family with fewer than three is filled up with made-up people
 * in three of core's member colours (people's colours are data, not styling).
 */
export const SAMPLE_PEOPLE = [
	{ id: 'sample_a', nameKey: 'appearance_sample_person_a', color: '#3d7aae' },
	{ id: 'sample_b', nameKey: 'appearance_sample_person_b', color: '#c38f22' },
	{ id: 'sample_c', nameKey: 'appearance_sample_person_c', color: '#2f9a94' },
] as const;

export interface SamplePerson {
	id: string;
	displayName: string;
	color: string;
}

/** The three people of the previews: the first three active members, then made-up ones. */
export function samplePeople(
	members: readonly { id: string; displayName: string; color: string; archived?: boolean }[],
	label: (key: (typeof SAMPLE_PEOPLE)[number]['nameKey']) => string,
): [SamplePerson, SamplePerson, SamplePerson] {
	const own = members
		.filter((m) => !m.archived)
		.slice(0, 3)
		.map(({ id, displayName, color }) => ({ id, displayName, color }));
	const made = SAMPLE_PEOPLE.slice(own.length).map((p) => ({
		id: p.id,
		displayName: label(p.nameKey),
		color: p.color,
	}));
	return [...own, ...made] as [SamplePerson, SamplePerson, SamplePerson];
}
