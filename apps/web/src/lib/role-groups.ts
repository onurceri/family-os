/**
 * The groups of the roles table and drawer: the family-wide one first, then the others by their
 * name in the reader's language, with that language's collation, so a permission is found by
 * looking down an alphabet rather than through the registry's order.
 */
export function orderedGroups<T>(
	groups: readonly (readonly [owner: string, items: T])[],
	name: (owner: string) => string,
	locale: string,
): (readonly [string, T])[] {
	const collator = new Intl.Collator(locale);
	return [...groups].sort(
		(a, b) =>
			Number(b[0] === 'core') - Number(a[0] === 'core') ||
			collator.compare(name(a[0]), name(b[0])) ||
			a[0].localeCompare(b[0]),
	);
}
