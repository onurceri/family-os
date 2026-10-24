/**
 * The outcome of reading a list again: the list to show, and whether the read worked. A read that
 * failed keeps the list already on screen (or none, when there never was one): a failure says
 * nothing about whether the list is empty.
 */
export interface ListRead<T> {
	list: T[];
	/** Whether this read worked, so an empty list may be called empty. */
	ok: boolean;
}

export async function readList<T>(
	load: () => Promise<T[]>,
	current: readonly T[],
): Promise<ListRead<T>> {
	try {
		return { list: await load(), ok: true };
	} catch {
		return { list: [...current], ok: false };
	}
}
