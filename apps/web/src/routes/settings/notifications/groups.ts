/** The parts of the notification settings, in the order the page shows them. */
export const GROUP_ORDER = ['everyday', 'approvals', 'system'] as const;
export type KindGroup = (typeof GROUP_ORDER)[number];

/**
 * The kinds sorted into the page's parts, in their fixed order, each keeping the order the server
 * listed its kinds in. A part with no kind is left out.
 */
export function groupKinds<K extends { group: KindGroup }>(
	kinds: readonly K[],
): { group: KindGroup; kinds: K[] }[] {
	return GROUP_ORDER.map((group) => ({
		group,
		kinds: kinds.filter((k) => k.group === group),
	})).filter((part) => part.kinds.length > 0);
}

/** The id of a kind's row, for links such as `#kind-<id>` from elsewhere in the app. */
export const kindAnchor = (id: string): string => `kind-${id}`;

/** The kind a `#kind-<id>` address points at, if it does. */
export function kindFromHash(hash: string): string | null {
	let id: string;
	try {
		id = decodeURIComponent(hash.replace(/^#/, ''));
	} catch {
		return null;
	}
	return id.startsWith('kind-') && id.length > 'kind-'.length ? id.slice('kind-'.length) : null;
}
