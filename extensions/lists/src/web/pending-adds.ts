/**
 * Items just added that the list shows at once, before the server's answer and the next read
 * of the list. A batch stays until a read that began after its add was saved has been applied:
 * only that read is sure to hold the new rows. An earlier read (one already on its way, or the
 * page's own read overtaken by a newer one) never takes them away, so the list cannot flash
 * empty between "Adding…" and the real rows. A failed add goes at once.
 */
export interface PendingItem {
	id: string;
	listId: string;
	title: string;
	quantity?: string;
}

interface Batch {
	id: string;
	items: readonly PendingItem[];
	/** The number of reads begun when the add was saved; null while it is being saved. */
	savedAfter: number | null;
}

export interface PendingAdds {
	readonly batches: readonly Batch[];
	/** Reads of the list begun so far. */
	readonly reads: number;
	readonly made: number;
}

export const noPendingAdds: PendingAdds = { batches: [], reads: 0, made: 0 };

/** Starts a batch of items being added; its id names it in `saved` and `failed`. */
export function addBatch(
	state: PendingAdds,
	items: readonly Omit<PendingItem, 'id'>[],
): { state: PendingAdds; batch: string } {
	const batch = `adding-${state.made + 1}`;
	return {
		batch,
		state: {
			...state,
			made: state.made + 1,
			batches: [
				...state.batches,
				{
					id: batch,
					items: items.map((item, i) => ({ ...item, id: `${batch}-${i}` })),
					savedAfter: null,
				},
			],
		},
	};
}

/** A read of the list begins: its number is what `readApplied` is given when it lands. */
export function readBegun(state: PendingAdds): { state: PendingAdds; read: number } {
	const read = state.reads + 1;
	return { read, state: { ...state, reads: read } };
}

/** The add was saved: the batch waits for the next read that begins from now on. */
export function saved(state: PendingAdds, batch: string): PendingAdds {
	return {
		...state,
		batches: state.batches.map((b) => (b.id === batch ? { ...b, savedAfter: state.reads } : b)),
	};
}

/** The add failed, or it is shown elsewhere now (kept for later, waiting for approval). */
export function failed(state: PendingAdds, batch: string): PendingAdds {
	return { ...state, batches: state.batches.filter((b) => b.id !== batch) };
}

/** A read's items replaced the list: the batches saved before it began are in it. */
export function readApplied(state: PendingAdds, read: number): PendingAdds {
	return {
		...state,
		batches: state.batches.filter((b) => b.savedAfter === null || read <= b.savedAfter),
	};
}

/** The items to show as being added, for one list. */
export const pendingItems = (state: PendingAdds, listId: string | undefined): PendingItem[] =>
	state.batches.flatMap((b) => b.items).filter((item) => item.listId === listId);
