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
