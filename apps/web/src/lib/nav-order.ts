import type { NavContribution } from '@famos/ui/slots';

type Orderable = Pick<NavContribution, 'order' | 'labelKey' | 'id'>;

/**
 * The page order: the number each page asks for, then its name in the reader's language, then
 * its id. Two pages asking for the same place always sit the same way, whichever extension
 * loaded first.
 */
export const orderedBy =
	(label: (key: string) => string, locale: string) => (a: Orderable, b: Orderable) =>
		(a.order ?? 0) - (b.order ?? 0) ||
		label(a.labelKey).localeCompare(label(b.labelKey), locale) ||
		a.id.localeCompare(b.id);

/**
 * The order inside a group of the sidebar and More: by name in the reader's language, then by id
 * so two pages with one name never swap. The numbers pages ask for only place the groups and the
 * rail and settings lists, never the pages inside a group.
 */
export function byName(label: (key: string) => string, locale: string) {
	const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
	return (a: Orderable, b: Orderable) =>
		collator.compare(label(a.labelKey), label(b.labelKey)) || a.id.localeCompare(b.id);
}

/** Groups in the order their first page comes in `items`; the pages inside each group by name. */
export function groupedByName<T extends Orderable & { group?: string }>(
	items: readonly T[],
	name: (a: Orderable, b: Orderable) => number,
): { group: string; items: T[] }[] {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const group = item.group ?? 'pages';
		groups.set(group, [...(groups.get(group) ?? []), item]);
	}
	return [...groups].map(([group, list]) => ({ group, items: list.toSorted(name) }));
}
