import { SvelteMap } from 'svelte/reactivity';
import { type ShoppingItem, type ShoppingItemInput, titleKey } from '../contract/index.js';

/** The items of a shopping list, once known; asking for an unknown list starts loading it. */
export type ItemsOnList = (listId: string | undefined) => readonly ShoppingItem[] | undefined;

/**
 * The list's current items for the draft cards. A card shows what adding would change on the
 * list ("Rice: 1 kg → a bag"), so it reads the list once through the lists API. The map is
 * reactive, so a card that asked shows the answer as soon as it arrives; an answer older than
 * `maxAgeMs` is asked for again (the old one stays until the new one comes). `listId` undefined
 * means the default list.
 */
export function itemsOnList(
	load: (listId: string | undefined) => Promise<readonly ShoppingItem[]>,
	maxAgeMs = 30_000,
	now: () => number = Date.now,
): ItemsOnList {
	const known = new SvelteMap<string, readonly ShoppingItem[]>();
	const askedAt = new Map<string, number>();
	return (listId) => {
		const key = listId ?? '';
		const at = askedAt.get(key);
		if (at === undefined || now() - at > maxAgeMs) {
			askedAt.set(key, now());
			// Started from a card's render: the map changes only after the load, never during it.
			load(listId).then(
				(items) => known.set(key, items),
				() => {},
			);
		}
		return known.get(key);
	};
}

export interface QuantityChange {
	/** The item as it is on the list. */
	title: string;
	from: string;
	to: string;
}

/**
 * The items already on the list whose quantity an add would replace with a different one. An add
 * without a quantity keeps the list's, and `keep` leaves everything as it is, so neither changes
 * anything.
 */
export function quantityChanges(
	items: readonly ShoppingItemInput[],
	onList: readonly ShoppingItem[],
	locale: string,
	whenOnList?: 'keep' | 'update',
): QuantityChange[] {
	if (whenOnList === 'keep') return [];
	const changes: QuantityChange[] = [];
	for (const item of items) {
		const to = item.quantity?.trim();
		if (!to) continue;
		const key = titleKey(item.title, locale);
		// An open item wins over a bought one with the same name, as it does on the server.
		const existing =
			onList.find((i) => !i.doneAt && titleKey(i.title, locale) === key) ??
			onList.find((i) => titleKey(i.title, locale) === key);
		const from = existing?.quantity?.trim();
		if (existing && from && from !== to) changes.push({ title: existing.title, from, to });
	}
	return changes;
}
