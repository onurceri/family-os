import type { Component } from 'svelte';

/**
 * Where a page appears in navigation:
 * - `primary`: a phone tab / rail entry. The phone shows at most three primary pages between
 *   "Today" and "More"; extra primary pages overflow into "More" by `order`.
 * - `more`: listed in the "More" menu under its group.
 */
export type NavPlacement = 'primary' | 'more';

export interface NavContribution {
	/** Unique, namespaced: `<extension>.<name>`. */
	id: string;
	/** Path under the SPA, e.g. `/shopping`. */
	path: string;
	/** i18n key, namespaced by extension, e.g. `shopping:nav`. */
	labelKey: string;
	/** Icon component (Lucide icons via `@lucide/svelte`). */
	icon?: Component;
	placement: NavPlacement;
	/** Groups in the "More" menu, e.g. `family`, `home`, `money`. */
	group?: string;
	/** Lower comes first. */
	order?: number;
	/** Capability needed to see this entry. */
	requires?: string;
	/** Number badge, e.g. pending drafts; refreshed by the app. */
	badge?: () => Promise<number>;
	/**
	 * The page where things are shared with the family (Quick add): the app links to it from Today
	 * ("Needs you") and gives it the `n` key. One entry of all extensions at most.
	 */
	share?: boolean;
	/** A key that opens the page after `g` (`c`: `g c` opens the calendar). */
	shortcut?: string;
	/**
	 * For a page in the `settings` group: the part of the settings list it belongs to (default
	 * `system`).
	 */
	section?: SettingsSection;
	/**
	 * Pages that belong under this entry (Tasks and Shopping under Lists). The sidebar shows them
	 * as a group that folds; the phone tabs and the rail show only this entry, whose page leads to
	 * one of them. Each child's path lies under the entry's path.
	 */
	children?: NavChild[];
}

/** A page under a navigation entry (`NavContribution.children`). */
export type NavChild = Pick<
	NavContribution,
	'id' | 'path' | 'labelKey' | 'icon' | 'requires' | 'badge'
>;

/**
 * The groups of the settings list: what is about you, the family,
 * the AI, and the system. The list is the settings sidebar on wide windows and More on phones.
 */
export const SETTINGS_SECTIONS = ['you', 'family', 'ai', 'system'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
