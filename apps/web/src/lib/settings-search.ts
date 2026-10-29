/**
 * The settings list's search: a filter over the rows' labels as the person types, groups without
 * a match drop out. A row may also be found by other words a person would try (privacy, export,
 * version): `words` gives them as one comma-separated string from the catalog. A list filter, not
 * a full-text index.
 */
export function filterSettings<S, I>(
	groups: readonly { section: S; items: readonly I[] }[],
	query: string,
	label: (item: I) => string,
	words: (item: I) => string = () => '',
): { section: S; items: I[] }[] {
	const q = query.trim().toLocaleLowerCase();
	const matches = (item: I) =>
		label(item).toLocaleLowerCase().includes(q) ||
		words(item)
			.toLocaleLowerCase()
			.split(',')
			.some((word) => word.trim().includes(q));
	return groups
		.map((g) => ({
			section: g.section,
			items: q ? g.items.filter(matches) : [...g.items],
		}))
		.filter((g) => g.items.length > 0);
}
