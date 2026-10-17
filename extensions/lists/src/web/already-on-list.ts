/** What `lists.addShoppingItems` answers, as far as telling what was already there needs it. */
export interface AddedItems {
	items: readonly { id: string; title: string; quantity: string | null }[];
	/** Items the call created. */
	addedIds: readonly string[];
	/** Items that were there before the call, as they were then (`doneAt` set: it was bought). */
	merged?: readonly { id: string; quantity: string | null; doneAt: number | null }[];
}

export interface AlreadyOnList {
	id: string;
	title: string;
	quantity: string | null;
	/** The add brought a new amount, which replaced the one on the list. */
	quantityChanged: boolean;
}

/**
 * The items an add found still on the list (not bought), so the page can say so instead of
 * seeming to do nothing. A bought item that came back from the cart is a visible change and
 * is not counted.
 */
export function alreadyOnList(output: AddedItems): AlreadyOnList[] {
	const added = new Set(output.addedIds);
	const before = new Map((output.merged ?? []).map((m) => [m.id, m]));
	const seen = new Set<string>();
	const found: AlreadyOnList[] = [];
	for (const item of output.items) {
		if (added.has(item.id) || seen.has(item.id)) continue;
		seen.add(item.id);
		const was = before.get(item.id);
		if (was && was.doneAt !== null) continue;
		found.push({
			id: item.id,
			title: item.title,
			quantity: item.quantity,
			quantityChanged: was !== undefined && was.quantity !== item.quantity,
		});
	}
	return found;
}
