/**
 * Whether the viewer may open a page. A page says who it is for with `requires` (a capability,
 * as its navigation entry does); the shell asks here once for every page, the app's own and the
 * extensions', and shows one calm "this page is for…" state instead of the page when the answer
 * is no. The server still refuses what the viewer may not do: this only keeps a page from opening
 * on reads and buttons that would all be refused. Plain functions, so the rule is tested without
 * a browser.
 */

/** What the shell reads of a page to decide. */
export interface PageDeclaration {
	requires?: string | undefined;
}

/** A navigation entry: where the page's name comes from. */
export interface PageEntry {
	path: string;
	labelKey: string;
	/** Other pages that belong to this entry (AI activity belongs to Usage & limits). */
	alsoOn?: readonly string[] | undefined;
	children?: readonly PageEntry[] | undefined;
}

export type PageAccess =
	| { open: true }
	| {
			open: false;
			/** The name of the page as its navigation entry has it, when it has one. */
			labelKey: string | undefined;
	  };

export const OPEN: PageAccess = { open: true };

/**
 * The entry a page belongs to: the entry on its path, or else the one whose path (or `alsoOn`)
 * is the longest parent of it (`/vehicles/:id` belongs to Vehicles). Children count as entries.
 */
export function entryFor<T extends PageEntry>(entries: readonly T[], path: string): T | undefined {
	const reaches = (base: string) => path === base || path.startsWith(`${base}/`);
	const all = entries.flatMap((e) => [e, ...((e.children ?? []) as readonly T[])]);
	return all
		.flatMap((entry) =>
			[entry.path, ...(entry.alsoOn ?? [])].filter(reaches).map((base) => ({ entry, base })),
		)
		.toSorted((a, b) => b.base.length - a.base.length)[0]?.entry;
}

/**
 * Whether the viewer may open the page on `path`. A page without `requires` is open to everyone
 * signed in; one with it only to those who hold the capability.
 */
export function pageAccess(args: {
	path: string;
	page: PageDeclaration | undefined;
	entries: readonly PageEntry[];
	can: (capability: string) => boolean;
}): PageAccess {
	const requires = args.page?.requires;
	if (!requires || args.can(requires)) return OPEN;
	return { open: false, labelKey: entryFor(args.entries, args.path)?.labelKey };
}
