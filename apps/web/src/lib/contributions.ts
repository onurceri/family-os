import type {
	AnyDraftPresenter,
	NavContribution,
	PageContribution,
	SlotContribution,
	TimelineContribution,
	TodayBlockContribution,
	TodayFacet,
	WebExtension,
} from '@famos/ui/slots';

/**
 * What the extensions add to the web app, collected from their `./web` entries. The app reads
 * only this: it never names an extension itself. Plain functions over the list of entries, so
 * the rules are tested without a browser; `contributions.svelte.ts` keeps the list.
 */
export interface Contributions {
	extensions: readonly WebExtension[];
	slots: readonly SlotContribution[];
	/** Navigation entries in `order`. */
	nav: readonly NavContribution[];
	/** Draft presenters by action id; Quick add renders drafts without knowing any extension. */
	presenters: ReadonlyMap<string, AnyDraftPresenter>;
	/** Extension pages by path, served by the catch-all route. */
	pages: ReadonlyMap<string, PageContribution>;
	timelines: readonly TimelineContribution[];
	facets: readonly TodayFacet[];
	blocks: readonly TodayBlockContribution[];
	/** The entry where things are shared with the family (Quick add), if an extension has one. */
	share: NavContribution | undefined;
	/** API reads kept for offline use, as full paths (`/api/v1/<extension>/…`, `:name` segments). */
	offlineReads: readonly string[];
}

/** What the app contributes itself (ids `app.<name>`, presenters of core actions). */
export interface AppContributions {
	slots?: readonly SlotContribution[];
	presenters?: readonly AnyDraftPresenter[];
}

/** The extension that owns a namespaced id (`calendar.page` → `calendar`; a block `chores`). */
export const ownerOf = (id: string) => id.split('.')[0] ?? id;

/** Contributions of extensions that are turned on (Settings → Features). */
export const enabledOnly = <T extends { id: string }>(
	items: readonly T[],
	off: readonly string[],
) => (off.length === 0 ? [...items] : items.filter((item) => !off.includes(ownerOf(item.id))));

/**
 * Collects the entries. Two entries with one id, two presenters of one action, two pages on one
 * path or two places to share are mistakes of the extensions: they are refused here, at start.
 */
export function collect(
	extensions: readonly WebExtension[],
	app: AppContributions = {},
): Contributions {
	const ids = new Set<string>();
	for (const e of extensions) {
		if (ids.has(e.id)) throw new Error(`Two web extensions have the id "${e.id}"`);
		ids.add(e.id);
	}
	const presenters = new Map<string, AnyDraftPresenter>();
	for (const d of [...extensions.flatMap((e) => e.drafts ?? []), ...(app.presenters ?? [])]) {
		if (presenters.has(d.actionId)) throw new Error(`Two draft presenters for "${d.actionId}"`);
		presenters.set(d.actionId, d);
	}
	const pages = new Map<string, PageContribution>();
	for (const p of extensions.flatMap((e) => e.pages ?? [])) {
		if (pages.has(p.path)) throw new Error(`Two pages on "${p.path}"`);
		pages.set(p.path, p);
	}
	const nav = extensions
		.flatMap((e) => e.nav ?? [])
		.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
	const shares = nav.filter((n) => n.share);
	if (shares.length > 1)
		throw new Error(`More than one place to share: ${shares.map((n) => n.id).join(', ')}`);
	return {
		extensions,
		slots: [...extensions.flatMap((e) => e.slots ?? []), ...(app.slots ?? [])],
		nav,
		presenters,
		pages,
		timelines: extensions.flatMap((e) => e.timeline ?? []),
		facets: extensions.flatMap((e) => e.today ?? []),
		blocks: extensions.flatMap((e) => e.blocks ?? []),
		share: shares[0],
		offlineReads: extensions.flatMap((e) =>
			(e.offlineReads ?? []).map((path) => `/api/v1/${e.id}${path}`),
		),
	};
}

/**
 * The page for a path: an exact match, else a pattern whose `:name` segments match one segment
 * each (`/vehicles/:id`); the matched values are the page's `params`.
 */
export function matchPage(
	pathname: string,
	pages: ReadonlyMap<string, PageContribution>,
): { page: PageContribution; params: Record<string, string> } | undefined {
	const path = pathname.replace(/\/+$/, '') || '/';
	const exact = pages.get(path);
	if (exact) return { page: exact, params: {} };
	const segments = path.split('/');
	for (const page of pages.values()) {
		const pattern = page.path.split('/');
		if (!page.path.includes(':') || pattern.length !== segments.length) continue;
		const params: Record<string, string> = {};
		const fits = pattern.every((part, i) => {
			const segment = segments[i] ?? '';
			if (!part.startsWith(':')) return part === segment;
			if (!segment) return false;
			params[part.slice(1)] = decodeURIComponent(segment);
			return true;
		});
		if (fits) return { page, params };
	}
	return undefined;
}

/** What a viewer is: what they hold and which extensions are turned off for them. */
export interface Viewer {
	can(capability: string): boolean;
	disabledExtensions: readonly string[];
}

const held = (c: { requires?: string | undefined }, viewer: Viewer) =>
	!c.requires || viewer.can(c.requires);

/** The facets of one kind a viewer may see, from extensions that are turned on. */
export function facetsOf<K extends TodayFacet['kind']>(
	facets: readonly TodayFacet[],
	kind: K,
	viewer: Viewer,
): Extract<TodayFacet, { kind: K }>[] {
	return enabledOnly(facets, viewer.disabledExtensions).filter(
		(f): f is Extract<TodayFacet, { kind: K }> => f.kind === kind && held(f, viewer),
	);
}

/**
 * Whether a viewer has a day on Today: the `requires` of any timeline contribution of an
 * extension that is turned on is held.
 */
export const hasDay = (timelines: readonly TimelineContribution[], viewer: Viewer): boolean =>
	enabledOnly(timelines, viewer.disabledExtensions).some((c) => viewer.can(c.requires));

/** The share entry when its extension is on and the viewer may use it. */
export const shareFor = (
	share: NavContribution | undefined,
	viewer: Viewer,
): { path: string; labelKey: string } | undefined =>
	share && enabledOnly([share], viewer.disabledExtensions).length > 0 && held(share, viewer)
		? { path: share.path, labelKey: share.labelKey }
		: undefined;
