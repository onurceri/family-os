import { SvelteMap } from 'svelte/reactivity';
import {
	type ShoppingItem,
	type ShoppingItemInput,
	type ShoppingList,
	titleKey,
} from '../contract/index.js';

/** The items of a shopping list, once known; asking for an unknown list starts loading it. */
export type ItemsOnList = (listId: string | undefined) => readonly ShoppingItem[] | undefined;

/**
 * A read for the draft cards, by key: the first ask starts loading and later asks get the answer.
 * The map is reactive, so a card that asked shows the answer as soon as it arrives; an answer
 * older than `maxAgeMs` is asked for again (the old one stays until the new one comes).
 */
function cachedReads<T>(
	load: (key: string | undefined) => Promise<T>,
	maxAgeMs: number,
	now: () => number,
): (key: string | undefined) => T | undefined {
	const known = new SvelteMap<string, T>();
	const askedAt = new Map<string, number>();
	return (key) => {
		const k = key ?? '';
		const at = askedAt.get(k);
		if (at === undefined || now() - at > maxAgeMs) {
			askedAt.set(k, now());
			// Started from a card's render: the map changes only after the load, never during it.
			load(key).then(
				(value) => known.set(k, value),
				() => {},
			);
		}
		return known.get(k);
	};
}

/**
 * The list's current items for the draft cards. A card shows what adding would change on the
 * list ("Rice: 1 kg → a bag"), so it reads the list once through the lists API. `listId`
 * undefined means the default list.
 */
export function itemsOnList(
	load: (listId: string | undefined) => Promise<readonly ShoppingItem[]>,
	maxAgeMs = 30_000,
	now: () => number = Date.now,
): ItemsOnList {
	return cachedReads(load, maxAgeMs, now);
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

/**
 * The list a draft adds to, by name, for the card: only when the family has more than one list
 * (with one there is nothing to choose). `listId` undefined means the default (first) list, which
 * can have no name of its own: then it is called `unnamed`, so the card always shows where an
 * item goes.
 */
export function draftListName(
	lists: readonly Pick<ShoppingList, 'id' | 'name'>[] | undefined,
	listId: string | undefined,
	unnamed = '',
): string | undefined {
	if (!lists || lists.length < 2) return undefined;
	const list = listId ? lists.find((l) => l.id === listId) : lists[0];
	return list ? list.name || unnamed || undefined : undefined;
}

/** The family's shopping lists for the draft cards, read once and kept fresh like `itemsOnList`. */
export function shoppingLists(
	load: () => Promise<readonly ShoppingList[]>,
	maxAgeMs = 30_000,
	now: () => number = Date.now,
): () => readonly ShoppingList[] | undefined {
	const read = cachedReads(() => load(), maxAgeMs, now);
	return () => read(undefined);
}
