/**
 * Numbers the loads of one source so that a response which arrives after a newer load started
 * is dropped: events come in bursts and answers may return out of order.
 */
export class LoadSequence {
	#last = 0;

	/** Starts a load; its number goes to `isCurrent` when the answer is in. */
	begin(): number {
		return ++this.#last;
	}

	/** Whether no newer load has started since `begin` gave `number`. */
	isCurrent(number: number): boolean {
		return number === this.#last;
	}
}

/**
 * Loads one source. A failing source answers with its last good result (or `empty` when it never
 * had one), so one failing extension does not blank what the page shows.
 */
export async function loadKeeping<T>(
	kept: Map<string, T>,
	key: string,
	load: () => Promise<T>,
	empty: T,
): Promise<T> {
	try {
		const result = await load();
		kept.set(key, result);
		return result;
	} catch {
		return kept.get(key) ?? empty;
	}
}
