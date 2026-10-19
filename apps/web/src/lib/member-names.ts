/** A name as compared between people: no outer spaces, no difference of case. */
export const nameKey = (name: string): string => name.trim().toLocaleLowerCase();

/**
 * Another member who already has this name (nobody when it is the member's own, unchanged), so
 * the members page can ask before it makes two people look alike. Two people may share a name;
 * the family only hears about it first.
 */
export function nameTwin<M extends { id: string; displayName: string }>(
	members: readonly M[],
	name: string,
	own?: { id: string; displayName: string } | null,
): M | undefined {
	const key = nameKey(name);
	if (key === '' || (own && nameKey(own.displayName) === key)) return undefined;
	return members.find((m) => m.id !== own?.id && nameKey(m.displayName) === key);
}
